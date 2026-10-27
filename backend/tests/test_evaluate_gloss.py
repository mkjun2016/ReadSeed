import unittest

import evaluate_gloss


class EvaluateGlossTest(unittest.TestCase):
    def test_metrics_count_wrong_definition_as_false_positive_and_false_negative(self):
        cases = [{"sentence": "문장", "word": "단어", "pos": "NNG", "candidates": [{"_local_id": "1:1", "난이도": "고급", "뜻풀이": "첫째"}, {"_local_id": "2:1", "난이도": "고급", "뜻풀이": "둘째"}], "expected_local_id": "2:1"}]
        result = evaluate_gloss.evaluate(cases, "rule")
        self.assertEqual((result["tp"], result["fp"], result["fn"]), (0, 0, 1))

    def test_metrics_count_safe_hiding_as_true_negative(self):
        cases = [{"sentence": "서울", "word": "서울", "pos": "NNP", "candidates": [{"_local_id": "1:1", "난이도": "고급", "뜻풀이": "수도"}], "expected_local_id": None}]
        result = evaluate_gloss.evaluate(cases, "rule")
        self.assertEqual((result["tn"], result["precision"]), (1, 1.0))
