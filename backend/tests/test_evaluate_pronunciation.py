import json
import tempfile
import unittest
from pathlib import Path

from evaluate_pronunciation import build_default_predictor, evaluate, load_cases


class EvaluatePronunciationTest(unittest.TestCase):
    def test_counts_correct_wrong_false_positive_and_abstention(self):
        cases = [
            self.case("correct", "같이", "가치"),
            self.case("wrong", "밭일", "반닐"),
            self.case("false-positive", "사람", "사람"),
            self.case("abstain", "국물", "궁물"),
            self.case("true-negative", "바다", "바다"),
        ]
        predictions = {
            "같이": self.prediction("가치", different=True),
            "밭일": self.prediction("바칠", different=True),
            "사람": self.prediction("사람", different=True),
            "국물": self.prediction("궁물", different=True, reliable=False),
            "바다": self.prediction("바다", different=False),
        }

        result = evaluate(cases, predictions.__getitem__)

        self.assertEqual(result["true_positive"], 1)
        self.assertEqual(result["false_positive"], 2)
        self.assertEqual(result["false_negative"], 2)
        self.assertEqual(result["true_negative"], 1)
        self.assertEqual(result["abstentions"], 1)
        self.assertAlmostEqual(result["precision"], 1 / 3)
        self.assertAlmostEqual(result["recall"], 1 / 3)
        self.assertEqual(
            [failure["reason"] for failure in result["failures"]],
            ["wrong_pronunciation", "false_positive", "missed_annotation"],
        )

    def test_rejects_duplicate_ids(self):
        payload = {
            "schema_version": 1,
            "cases": [self.case("same", "같이", "가치"), self.case("same", "국물", "궁물")],
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "gold.json"
            path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "중복 id"):
                load_cases(path)

    def test_current_classifier_keeps_precision_target(self):
        result = evaluate(load_cases(), build_default_predictor())

        self.assertEqual(result["total"], 49)
        self.assertGreaterEqual(result["precision"], 0.95)
        self.assertEqual(result["failures"], [])

    @staticmethod
    def case(case_id, surface, expected):
        return {
            "id": case_id,
            "surface": surface,
            "expected_pronunciation": expected,
            "category": "test",
            "source": "test",
        }

    @staticmethod
    def prediction(pronunciation, *, different, reliable=True):
        return {"발음": pronunciation, "다름": different, "신뢰": reliable}


if __name__ == "__main__":
    unittest.main()
