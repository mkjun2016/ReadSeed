import unittest
from unittest.mock import patch

import gloss_selector
import pipeline
import reflow


def entry(definition, local_id):
    return {"_local_id": local_id, "표제어": "조사", "품사": "명사", "난이도": "고급", "뜻풀이": definition}


class AgentTraceTest(unittest.TestCase):
    def test_trace_starts_with_a_plan_and_ends_with_timing(self):
        result = pipeline.explain_sentence("고양이 3마리가 굳이 왔다.", use_llm=False, profile={"구개음화": "struggle"})
        steps = [step["단계"] for step in result["trace"]]
        self.assertEqual(steps[0], "계획")
        self.assertIn("숫자 읽기 규칙", result["trace"][0]["판단"])
        self.assertIn("보호자가 AI를 꺼서 규칙만", result["trace"][0]["판단"])
        self.assertEqual(steps[-1], "완료")
        palatal = next(step for step in result["trace"] if step.get("어절") == "굳이")
        self.assertIn("자주 막힌 소리", palatal["판단"])

    def test_unsure_ai_choice_goes_to_human_review_not_to_the_screen(self):
        candidates = [entry("조문", "1:1"), entry("내용을 자세히 살펴봄", "2:1")]
        unsure = gloss_selector.Selection(None, "llm_uncertain", 0.6, suggestion=candidates[1])
        with patch.object(pipeline.dict_lookup, "lookup", return_value=candidates), patch.object(pipeline.gloss_selector, "select_many", side_effect=lambda sentence, items, use_llm=True: [unsure] * len(items)):
            result = pipeline.explain_sentence("경찰이 조사를 했다.")
        word = next(w for w in result["annotations"] if w["표기"] == "조사를")
        self.assertEqual(word["뜻풀이후보"], [])
        self.assertEqual(word["뜻검토"]["제안"], "2:1")
        self.assertEqual(len(word["뜻검토"]["후보"]), 2)
        self.assertTrue(any(step["단계"] == "사람 확인" for step in result["trace"]))


class OcrUncertaintyTest(unittest.TestCase):
    def test_low_confidence_line_marks_its_paragraph(self):
        lines = [
            {"text": "첫 문단은 또렷하게 읽혔어요.", "x": 0.1, "y": 0.10, "w": 0.6, "h": 0.03, "confidence": 1.0},
            {"text": "둘째 문단은 흐릿했어요.", "x": 0.15, "y": 0.15, "w": 0.5, "h": 0.03, "confidence": 0.5},
        ]
        block = reflow.reflow(lines)[0]
        self.assertEqual(len(block["paragraphs"]), 2)
        self.assertEqual(block["uncertain"], [False, True])


if __name__ == "__main__":
    unittest.main()
