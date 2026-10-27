import types
import unittest
from unittest.mock import patch

import gloss_selector
import pipeline


def entry(definition, *, level="고급", local_id="100:1"):
    return {"_local_id": local_id, "표제어": "단어", "품사": "명사", "난이도": level, "뜻풀이": definition}


class PipelineTest(unittest.TestCase):
    def setUp(self):
        pipeline._gloss_cache.clear()
        gloss_selector.clear_cache()

    def tearDown(self):
        pipeline._gloss_cache.clear()
        gloss_selector.clear_cache()

    def test_word_spans_tracks_non_whitespace_chunks(self):
        sentence = "  같이,\t국밥을 먹었다. "
        chunks = [sentence[start:end] for start, end in pipeline._word_spans(sentence)]
        self.assertEqual(chunks, ["같이,", "국밥을", "먹었다."])

    def test_lookup_gloss_keeps_one_local_single_sense_and_caches_by_context(self):
        selected = gloss_selector.Selection(entry("어려운 뜻"), "llm_selected", 0.95)
        with (patch.object(pipeline.dict_lookup, "lookup", return_value=[entry("어려운 뜻")]) as primary, patch.object(pipeline.gloss_selector, "select", return_value=selected)):
            first = pipeline._lookup_gloss("이 문장의 단어", "단어", "NNG")
            second = pipeline._lookup_gloss("이 문장의 단어", "단어", "NNG")
        self.assertEqual(first, [{"출처": "한국어기초사전", "표제어": "단어", "품사": "명사", "뜻풀이": "어려운 뜻"}])
        self.assertIs(first, second)
        primary.assert_called_once_with("단어")

    def test_lookup_gloss_hides_nonlocal_and_ambiguous_candidates_without_llm(self):
        ambiguous = [entry("첫째", local_id="1:1"), entry("둘째", local_id="2:1")]
        with patch.object(pipeline.dict_lookup, "lookup", return_value=ambiguous):
            self.assertEqual(pipeline._lookup_gloss("조사를 시작했다.", "조사", "NNG"), [])
        with patch.object(pipeline.dict_lookup, "lookup", return_value=[entry("원격", local_id=None)]):
            self.assertEqual(pipeline._lookup_gloss("문장", "단어", "NNG"), [])

    def test_annotate_sentence_excludes_proper_nouns(self):
        sentence = "서울 해지"
        tokens = [types.SimpleNamespace(start=0, form="서울", tag="NNP"), types.SimpleNamespace(start=3, form="해지", tag="NNG")]
        phonology = {"발음": "x", "다름": False, "유형": "없음", "신뢰": True}
        with (patch.object(pipeline.kiwi, "tokenize", return_value=tokens), patch.object(pipeline.phonology_rules, "classify", return_value=phonology), patch.object(pipeline.gloss_selector, "select_many", return_value=[gloss_selector.Selection(None, "test")]) as select_many):
            result = pipeline.annotate_sentence(sentence)
        self.assertEqual([item["어절"] for item in result], ["서울", "해지"])
        self.assertEqual(select_many.call_args.args[1][0][:2], ("해지", "NNG"))

    def test_annotate_sentence_preserves_eojeol_and_skips_non_hangul(self):
        sentence = "같이, 123 국밥!"
        tokens = [types.SimpleNamespace(start=0, form="같이", tag="MAG"), types.SimpleNamespace(start=8, form="국밥", tag="NNG")]
        def classify(surface, _g2p):
            return {"발음": {"같이": "가치", "국밥": "국빱"}[surface], "다름": True, "유형": "테스트", "신뢰": True}
        selected = gloss_selector.Selection(entry("음식"), "test")
        with (patch.object(pipeline.kiwi, "tokenize", return_value=tokens), patch.object(pipeline.phonology_rules, "classify", side_effect=classify) as classifier, patch.object(pipeline.gloss_selector, "select_many", return_value=[selected]) as select_many):
            result = pipeline.annotate_sentence(sentence)
        self.assertEqual([item["어절"] for item in result], ["같이,", "국밥!"])
        self.assertEqual(result[0]["뜻풀이후보"], [])
        self.assertEqual(result[1]["뜻풀이후보"][0]["뜻풀이"], "음식")
        self.assertEqual([call.args[0] for call in classifier.call_args_list], ["같이", "국밥"])
        self.assertEqual(select_many.call_args.args[1][0][:2], ("국밥", "NNG"))
