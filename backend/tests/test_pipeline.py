import types
import unittest
from unittest.mock import patch

import pipeline


class PipelineTest(unittest.TestCase):
    def setUp(self):
        pipeline._gloss_cache.clear()

    def tearDown(self):
        pipeline._gloss_cache.clear()

    def test_word_spans_tracks_non_whitespace_chunks(self):
        sentence = "  같이,\t국밥을 먹었다. "

        chunks = [sentence[start:end] for start, end in pipeline._word_spans(sentence)]

        self.assertEqual(chunks, ["같이,", "국밥을", "먹었다."])

    def test_lookup_gloss_uses_primary_dictionary_and_cache(self):
        entries = [
            {"표제어": f"단어{i}", "품사": "명사", "뜻풀이": f"뜻{i}"}
            for i in range(4)
        ]
        with (
            patch.object(pipeline.dict_lookup, "lookup", return_value=entries) as primary,
            patch.object(pipeline.urimalsam_lookup, "search") as fallback,
        ):
            first = pipeline._lookup_gloss("단어")
            second = pipeline._lookup_gloss("단어")

        self.assertEqual(len(first), 3)
        self.assertTrue(all(item["출처"] == "한국어기초사전" for item in first))
        self.assertIs(first, second)
        primary.assert_called_once_with("단어")
        fallback.assert_not_called()

    def test_lookup_gloss_falls_back_to_urimalsam(self):
        fallback_entries = [{"표제어": "수급자", "품사": "명사", "뜻풀이": "급여를 받는 사람"}]
        with (
            patch.object(pipeline.dict_lookup, "lookup", return_value=[]),
            patch.object(pipeline.urimalsam_lookup, "search", return_value=fallback_entries),
        ):
            result = pipeline._lookup_gloss("수급자")

        self.assertEqual(
            result,
            [{"출처": "우리말샘", "표제어": "수급자", "품사": "명사", "뜻풀이": "급여를 받는 사람"}],
        )

    def test_annotate_sentence_preserves_eojeol_and_skips_non_hangul(self):
        sentence = "같이, 123 국밥!"
        tokens = [
            types.SimpleNamespace(start=0, form="같이", tag="MAG"),
            types.SimpleNamespace(start=8, form="국밥", tag="NNG"),
        ]

        def classify(surface, _g2p):
            pronunciations = {"같이": "가치", "국밥": "국빱"}
            return {
                "발음": pronunciations[surface],
                "다름": True,
                "유형": "테스트",
                "신뢰": True,
            }

        with (
            patch.object(pipeline.kiwi, "tokenize", return_value=tokens),
            patch.object(pipeline.phonology_rules, "classify", side_effect=classify) as classifier,
            patch.object(
                pipeline,
                "_lookup_gloss",
                return_value=[{"출처": "사전", "표제어": "국밥", "품사": "명사", "뜻풀이": "음식"}],
            ) as lookup,
        ):
            result = pipeline.annotate_sentence(sentence)

        self.assertEqual([item["어절"] for item in result], ["같이,", "국밥!"])
        self.assertEqual([item["표기"] for item in result], ["같이", "국밥"])
        self.assertEqual(result[0]["형태소"], [("같이", "MAG")])
        self.assertEqual(result[0]["뜻풀이후보"], [])
        self.assertEqual(result[1]["형태소"], [("국밥", "NNG")])
        self.assertEqual(result[1]["뜻풀이후보"][0]["뜻풀이"], "음식")
        self.assertEqual([call.args[0] for call in classifier.call_args_list], ["같이", "국밥"])
        lookup.assert_called_once_with("국밥")


if __name__ == "__main__":
    unittest.main()
