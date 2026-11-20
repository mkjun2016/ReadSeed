import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import daily_passage  # noqa: E402


class DailyPassageTest(unittest.TestCase):
    def test_every_basic_passage_passes_the_rule_check(self):
        # AI가 없을 때 쓰는 기본 글도 그 소리가 실제로 일어나는 낱말을 충분히 담아야 한다.
        for rule, passage in daily_passage.BASIC.items():
            with self.subTest(rule=rule):
                verdict = daily_passage.check(passage["text"], rule)
                self.assertTrue(verdict["ok"], verdict["problems"])

    def test_other_sound_changes_are_limited_like_a_decodable_text(self):
        # 구개음화 연습 글에 된소리·거센소리 낱말이 잔뜩 섞이면 다시 쓰게 한다.
        mixed = "우리는 같이 학교에 갔다. 굳이 국밥을 먹었다. 해돋이를 보니 좋다고 했다. 식당 밭이 넓었다. 맏이가 웃었다. 끝이 났다."
        verdict = daily_passage.check(mixed, "구개음화")
        self.assertGreater(len(verdict["others"]), daily_passage.MAX_OTHER)
        self.assertFalse(verdict["ok"])
        self.assertTrue(any("다른 소리 변동" in problem for problem in verdict["problems"]))

    def test_targets_are_decided_by_rules_not_by_ai(self):
        targets, _ = daily_passage.find_targets("우리는 같이 해돋이를 보았다. 굳이 말하지 않았다.", "구개음화")
        self.assertEqual([t["표기"] for t in targets], ["같이", "해돋이를", "굳이"])
        self.assertEqual(targets[0]["발음"], "가치")

    def test_ai_draft_is_rewritten_until_it_passes_then_cached(self):
        weak = {"title": "글", "text": "나는 학교에 갔다. 밥을 먹었다. 집에 왔다. 잠을 잤다."}
        strong = {"title": "해돋이", "text": daily_passage.BASIC["구개음화"]["text"]}
        with tempfile.TemporaryDirectory() as folder, patch.object(daily_passage, "CACHE_DIR", Path(folder)), \
                patch.object(daily_passage, "_ask_claude", side_effect=[weak, strong]) as ask:
            first = daily_passage.generate("구개음화", "2026-11-20")
            again = daily_passage.generate("구개음화", "2026-11-20")
        self.assertEqual(first["source"], "ai")
        self.assertEqual(ask.call_count, 2)  # 두 번째 요청에 검사 결과가 들어간다
        feedback = ask.call_args_list[1].args[0][-1]["content"]
        self.assertIn("검사 결과", feedback)
        self.assertEqual(again["text"], first["text"])  # 같은 날은 저장된 글

    def test_without_ai_the_checked_basic_passage_is_used(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(daily_passage, "CACHE_DIR", Path(folder)), \
                patch.object(daily_passage, "_ask_claude", return_value=None):
            result = daily_passage.generate("유음화", "2026-11-20")
            self.assertEqual(result["source"], "basic")
            self.assertGreaterEqual(len(result["targets"]), daily_passage.MIN_TARGETS)
            self.assertFalse(any(Path(folder).iterdir()))  # 기본 글은 저장하지 않는다

    def test_unknown_rule_is_refused(self):
        with self.assertRaises(ValueError):
            daily_passage.generate("아무거나", "2026-11-20")


if __name__ == "__main__":
    unittest.main()
