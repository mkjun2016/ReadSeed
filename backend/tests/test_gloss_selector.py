import os
import tempfile
import unittest
from unittest.mock import patch

import gloss_selector


def entry(definition, *, level="고급", local_id="1:1"):
    return {"_local_id": local_id, "난이도": level, "뜻풀이": definition, "동형어번호": "0", "뜻번호": "1"}


class GlossSelectorTest(unittest.TestCase):
    def setUp(self):
        gloss_selector.clear_cache()
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.cache_path = os.path.join(self.temporary_directory.name, "cache.sqlite3")
        self.cache_patch = patch.object(gloss_selector, "CACHE_DB_PATH", gloss_selector.Path(self.cache_path))
        self.cache_patch.start()

    def tearDown(self):
        gloss_selector.clear_cache()
        self.cache_patch.stop()
        self.temporary_directory.cleanup()

    def test_rule_hides_proper_nouns_beginner_and_ambiguous_words(self):
        self.assertIsNone(gloss_selector.select_rule_only("서울", "NNP", [entry("도시")]).candidate)
        self.assertIsNone(gloss_selector.select_rule_only("최고", "NNG", [entry("가장 좋음", level="초급")]).candidate)
        self.assertIsNone(gloss_selector.select_rule_only("국민", "NNG", [entry("한 나라 사람", level="중급")]).candidate)
        mixed_levels = [entry("가장 오래됨", local_id="1:1"), entry("가장 좋음", level="초급", local_id="2:1")]
        self.assertIsNone(gloss_selector.select_rule_only("최고", "NNG", mixed_levels).candidate)
        choices = [entry("조문", local_id="1:1"), entry("살펴봄", local_id="2:1")]
        self.assertIsNone(gloss_selector.select_rule_only("조사", "NNG", choices).candidate)

    def test_rule_keeps_one_non_beginner_local_sense(self):
        result = gloss_selector.select_rule_only("해지", "NNG", [entry("계약 관계를 끝냄")])
        self.assertEqual(result.candidate["뜻풀이"], "계약 관계를 끝냄")

    def test_actual_overlay_selector_hides_when_llm_is_not_configured(self):
        with patch.dict(os.environ, {}, clear=True):
            result = gloss_selector.select("계약을 해지했다.", "해지", "NNG", [entry("계약 관계를 끝냄")])
        self.assertIsNone(result.candidate)
        self.assertEqual(result.reason, "llm_not_configured")

    def test_llm_can_only_select_an_existing_high_confidence_candidate_and_is_cached(self):
        candidates = [entry("조문하는 글", local_id="1:1"), entry("내용을 자세히 살펴봄", local_id="2:1")]
        config = {"GLOSS_LLM_API_URL": "https://example.test/v1/chat/completions", "GLOSS_LLM_API_KEY": "key", "GLOSS_LLM_MODEL": "test"}
        answer = {"decision": "show", "candidate_index": 1, "confidence": 0.91}
        with patch.dict(os.environ, config, clear=True), patch.object(gloss_selector, "_request_llm_batch", return_value=[answer]) as request:
            first = gloss_selector.select("경찰은 사건 조사를 시작했다.", "조사", "NNG", candidates)
            second = gloss_selector.select("경찰은 사건 조사를 시작했다.", "조사", "NNG", candidates)
        self.assertEqual(first.candidate["뜻풀이"], "내용을 자세히 살펴봄")
        self.assertEqual(second.candidate["뜻풀이"], "내용을 자세히 살펴봄")
        request.assert_called_once()

    def test_llm_invalid_answer_hides_annotation(self):
        candidates = [entry("첫째", local_id="1:1"), entry("둘째", local_id="2:1")]
        config = {"GLOSS_LLM_API_URL": "https://example.test", "GLOSS_LLM_API_KEY": "key", "GLOSS_LLM_MODEL": "test"}
        with patch.dict(os.environ, config, clear=True), patch.object(gloss_selector, "_request_llm_batch", return_value=[{"decision": "show", "candidate_index": 99, "confidence": 1}]):
            result = gloss_selector.select("문장", "단어", "NNG", candidates)
        self.assertIsNone(result.candidate)

    def test_anthropic_provider_uses_messages_shape(self):
        candidates = [entry("계약 관계를 끝냄")]
        config = {"GLOSS_LLM_PROVIDER": "anthropic", "ANTHROPIC_API_KEY": "key", "GLOSS_LLM_MODEL": "claude-test"}
        response = type("Response", (), {"raise_for_status": lambda self: None, "json": lambda self: {"content": [{"type": "text", "text": '{"decisions":[{"item_index":0,"decision":"show","candidate_index":0,"confidence":0.95}]}'}]}})()
        with patch.dict(os.environ, config, clear=True), patch.object(gloss_selector.requests, "post", return_value=response) as post:
            result = gloss_selector.select("계약을 해지했다.", "해지", "NNG", candidates)
        self.assertEqual(result.candidate["뜻풀이"], "계약 관계를 끝냄")
        self.assertEqual(post.call_args.args[0], "https://api.anthropic.com/v1/messages")
        self.assertEqual(post.call_args.kwargs["headers"]["anthropic-version"], "2023-06-01")
