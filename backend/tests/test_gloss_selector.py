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

    def test_without_llm_only_a_single_advanced_sense_is_shown(self):
        # AI가 없거나 보호자가 껐을 때도 뜻이 하나뿐인 고급어는 규칙만으로 확실하다.
        with patch.dict(os.environ, {}, clear=True):
            single = gloss_selector.select("계약을 해지했다.", "해지", "NNG", [entry("계약 관계를 끝냄")])
            several = gloss_selector.select("조사를 했다.", "조사", "NNG", [entry("조문", local_id="1:1"), entry("살펴봄", local_id="2:1")])
        self.assertEqual(single.reason, "single_sense")
        self.assertIsNone(several.candidate)
        self.assertEqual(several.reason, "llm_not_configured")

    def test_llm_switch_off_never_calls_the_api(self):
        config = {"GLOSS_LLM_API_URL": "https://example.test/v1/chat/completions", "GLOSS_LLM_API_KEY": "key", "GLOSS_LLM_MODEL": "test"}
        choices = [entry("조문", local_id="1:1"), entry("살펴봄", local_id="2:1")]
        gloss_selector.clear_cache()
        with patch.dict(os.environ, config, clear=True), patch.object(gloss_selector, "_request_llm_batch") as request:
            result = gloss_selector.select("조사를 했다.", "조사", "NNG", choices, use_llm=False)
        request.assert_not_called()
        self.assertEqual(result.reason, "llm_off")

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

    @staticmethod
    def _response(body, status=200):
        return type("Response", (), {"status_code": status, "raise_for_status": lambda self: None, "json": lambda self: body})()

    def test_claude_uses_tools_then_submits_a_decision(self):
        # 1차 응답: 사전 정보 조회 도구 호출, 2차 응답: 결정 제출 도구 호출
        candidates = [entry("조문", local_id="1:1"), entry("내용을 자세히 살펴봄", local_id="2:1")]
        config = {"GLOSS_LLM_PROVIDER": "anthropic", "ANTHROPIC_API_KEY": "key", "GLOSS_LLM_MODEL": "claude-test"}
        lookup = self._response({"content": [{"type": "tool_use", "id": "t1", "name": "get_sense_details", "input": {"item_index": 0, "candidate_indexes": [0, 1]}}]})
        submit = self._response({"content": [{"type": "tool_use", "id": "t2", "name": "submit_decisions", "input": {"decisions": [{"item_index": 0, "decision": "show", "candidate_index": 1, "confidence": 0.93}]}}]})
        gloss_selector.clear_cache()
        gloss_selector.reset_circuit()
        sink = gloss_selector.start_trace()
        with patch.dict(os.environ, config, clear=True), patch.object(gloss_selector, "_load_persistent", return_value=None), patch.object(gloss_selector, "_store_selection"), patch.object(gloss_selector.requests, "post", side_effect=[lookup, submit]) as post:
            result = gloss_selector.select("경찰은 사건 조사를 시작했다.", "조사", "NNG", candidates)
        self.assertEqual(result.candidate["뜻풀이"], "내용을 자세히 살펴봄")
        self.assertEqual(post.call_count, 2)
        second = post.call_args_list[1].kwargs["json"]
        self.assertEqual(second["messages"][-1]["content"][0]["type"], "tool_result")
        self.assertEqual(post.call_args_list[0].args[0], "https://api.anthropic.com/v1/messages")
        self.assertTrue(any(e.get("도구") == "get_sense_details" for e in sink))

    def test_transient_errors_are_retried_with_backoff(self):
        candidates = [entry("조문", local_id="1:1"), entry("살펴봄", local_id="2:1")]
        config = {"GLOSS_LLM_PROVIDER": "anthropic", "ANTHROPIC_API_KEY": "key", "GLOSS_LLM_MODEL": "claude-test"}
        busy = self._response({}, status=529)
        submit = self._response({"content": [{"type": "tool_use", "id": "t", "name": "submit_decisions", "input": {"decisions": [{"item_index": 0, "decision": "show", "candidate_index": 0, "confidence": 0.9}]}}]})
        gloss_selector.clear_cache()
        gloss_selector.reset_circuit()
        sink = gloss_selector.start_trace()
        with patch.dict(os.environ, config, clear=True), patch.object(gloss_selector, "_load_persistent", return_value=None), patch.object(gloss_selector, "_store_selection"), patch.object(gloss_selector.time, "sleep") as sleep, patch.object(gloss_selector.requests, "post", side_effect=[busy, submit]):
            result = gloss_selector.select("조사를 했다.", "조사", "NNG", candidates)
        self.assertEqual(result.reason, "llm_selected")
        sleep.assert_called_once()
        self.assertTrue(any("재시도" in e.get("판단", "") for e in sink))

    def test_circuit_breaker_falls_back_to_rules_after_repeated_failures(self):
        candidates = [entry("조문", local_id="1:1"), entry("살펴봄", local_id="2:1")]
        config = {"GLOSS_LLM_PROVIDER": "anthropic", "ANTHROPIC_API_KEY": "key", "GLOSS_LLM_MODEL": "claude-test"}
        down = gloss_selector.requests.exceptions.ConnectionError("down")
        gloss_selector.reset_circuit()
        with patch.dict(os.environ, config, clear=True), patch.object(gloss_selector, "_load_persistent", return_value=None), patch.object(gloss_selector, "_store_selection"), patch.object(gloss_selector.time, "sleep"), patch.object(gloss_selector.requests, "post", side_effect=down) as post:
            for i in range(gloss_selector.CIRCUIT_FAILURES):
                gloss_selector.clear_cache()
                failed = gloss_selector.select(f"문장 {i}", "조사", "NNG", candidates)
            calls = post.call_count
            gloss_selector.clear_cache()
            skipped = gloss_selector.select("다음 문장", "조사", "NNG", candidates)
        self.assertEqual(failed.reason, "llm_failed")
        self.assertTrue(gloss_selector.circuit_open())
        self.assertEqual(post.call_count, calls)  # 차단 중에는 호출하지 않는다
        self.assertIsNone(skipped.candidate)
        gloss_selector.reset_circuit()

    def test_uncertain_choice_is_kept_as_a_suggestion_for_review(self):
        candidates = [entry("조문", local_id="1:1"), entry("살펴봄", local_id="2:1")]
        config = {"GLOSS_LLM_API_URL": "https://example.test", "GLOSS_LLM_API_KEY": "key", "GLOSS_LLM_MODEL": "test"}
        gloss_selector.clear_cache()
        with patch.dict(os.environ, config, clear=True), patch.object(gloss_selector, "_load_persistent", return_value=None), patch.object(gloss_selector, "_store_selection"), patch.object(gloss_selector, "_request_llm_batch", return_value=[{"decision": "show", "candidate_index": 1, "confidence": 0.6}]):
            result = gloss_selector.select("조사를 했다.", "조사", "NNG", candidates)
        self.assertIsNone(result.candidate)
        self.assertEqual(result.suggestion["_local_id"], "2:1")
