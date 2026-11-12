import json
import unittest
from pathlib import Path

import numerals
import pipeline


class NumeralTest(unittest.TestCase):
    def test_gold_cases(self):
        gold = json.loads((Path(__file__).resolve().parent.parent / "data" / "number_gold.json").read_text(encoding="utf-8"))
        for case in gold["cases"]:
            got = numerals.read(case["token"])
            reading = got["읽기"] if got else "(표시 안 함)"
            self.assertEqual(reading.replace(" ", ""), case["expected"].replace(" ", ""), case["token"])

    def test_native_and_sino_forms(self):
        self.assertEqual(numerals.native(20), "스무")
        self.assertEqual(numerals.native(34), "서른네")
        self.assertIsNone(numerals.native(100))
        self.assertEqual(numerals.sino(1110), "천백십")
        self.assertEqual(numerals.sino(2024), "이천이십사")

    def test_codes_and_ambiguous_units_are_skipped(self):
        for token in ("010", "3번", "123456개", "3마리abc"):
            self.assertIsNone(numerals.read(token), token)

    def test_pipeline_marks_numbers_as_reading_hints(self):
        words = {w["표기"]: w for w in pipeline.annotate_sentence("고양이 3마리가 3학년 교실에 왔어요.", use_llm=False)}
        self.assertEqual(words["3마리가"]["발음"], "세 마리가")
        self.assertEqual(words["3학년"]["유형"], "숫자 읽기")


if __name__ == "__main__":
    unittest.main()
