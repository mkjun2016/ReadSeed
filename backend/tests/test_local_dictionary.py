import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import build_local_dictionary
import dict_lookup
import local_dictionary
import urimalsam_lookup


def sample_entry():
    return {
        "Lemma": {"feat": {"att": "writtenForm", "val": "해지"}},
        "Sense": [
            {
                "att": "id",
                "val": "1",
                "feat": [{"att": "definition", "val": "계약으로 성립된 관계를 끝냄."}],
            },
            {
                "att": "id",
                "val": "2",
                "feat": [{"att": "definition", "val": "풀어 없앰."}],
            },
        ],
        "WordForm": {
            "feat": [
                {"att": "type", "val": "발음"},
                {"att": "pronunciation", "val": "해ː지"},
            ]
        },
        "att": "id",
        "val": "100",
        "feat": [
            {"att": "homonym_number", "val": "1"},
            {"att": "partOfSpeech", "val": "명사"},
            {"att": "vocabularyLevel", "val": "고급"},
            {"att": "origin", "val": "解止"},
            {"att": "subjectCategiory", "val": "법률"},
        ],
    }


class LocalDictionaryTest(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.source_directory = Path(self.temporary_directory.name) / "source"
        self.source_directory.mkdir()
        self.database_path = Path(self.temporary_directory.name) / "krdict.sqlite3"
        source = {"LexicalResource": {"Lexicon": {"LexicalEntry": [sample_entry()]}}}
        (self.source_directory / "sample.json").write_text(json.dumps(source, ensure_ascii=False), encoding="utf-8")
        self.entries, self.senses = build_local_dictionary.build(self.source_directory, self.database_path)
        self.path_patch = patch.object(local_dictionary, "DATABASE_PATH", self.database_path)
        self.path_patch.start()

    def tearDown(self):
        self.path_patch.stop()
        self.temporary_directory.cleanup()

    def test_build_and_lookup_preserve_requested_fields(self):
        entries = local_dictionary.lookup("해지")

        self.assertEqual((self.entries, self.senses), (1, 2))
        self.assertEqual(len(entries), 2)
        self.assertEqual(
            entries[0],
            {
                "표제어": "해지",
                "동형어번호": "1",
                "품사": "명사",
                "난이도": "고급",
                "한자": "解止",
                "발음": "해ː지",
                "뜻번호": "1",
                "뜻풀이": "계약으로 성립된 관계를 끝냄.",
                "분야": "법률",
                "_local_id": "100:1",
            },
        )

    def test_dict_lookup_uses_local_database_before_open_api(self):
        with patch.object(dict_lookup.requests, "get") as request:
            entries = dict_lookup.lookup("해지")

        self.assertEqual(entries[0]["뜻풀이"], "계약으로 성립된 관계를 끝냄.")
        request.assert_not_called()

    def test_urimalsam_search_and_view_use_local_database_before_open_api(self):
        with patch.object(urimalsam_lookup.requests, "get") as request:
            candidates = urimalsam_lookup.search("해지")
            detail = urimalsam_lookup.view(candidates[0]["target_code"])

        self.assertEqual(candidates[0]["target_code"], "local:100:1")
        self.assertEqual(detail, {"표제어": "해지", "발음": "해ː지", "뜻풀이": "계약으로 성립된 관계를 끝냄."})
        request.assert_not_called()

    def test_dictionary_api_failure_uses_temporary_cooldown_not_server_lifetime_lock(self):
        original_key = dict_lookup.API_KEY
        original_retry_after = dict_lookup._api_retry_after
        dict_lookup.API_KEY = "test-key"
        dict_lookup._api_retry_after = 0
        try:
            with (
                patch.object(local_dictionary, "lookup", return_value=[]),
                patch.object(dict_lookup.requests, "get", side_effect=dict_lookup.requests.exceptions.Timeout),
            ):
                self.assertEqual(dict_lookup.lookup("없는단어"), [])
            self.assertGreater(dict_lookup._api_retry_after, 0)
            dict_lookup._api_retry_after = 0  # cooldown elapsed
            with (
                patch.object(local_dictionary, "lookup", return_value=[]),
                patch.object(dict_lookup.requests, "get", return_value=type("Response", (), {"text": "<channel />", "raise_for_status": lambda self: None})()) as request,
            ):
                self.assertEqual(dict_lookup.lookup("없는단어"), [])
            request.assert_called_once()
        finally:
            dict_lookup.API_KEY = original_key
            dict_lookup._api_retry_after = original_retry_after


if __name__ == "__main__":
    unittest.main()
