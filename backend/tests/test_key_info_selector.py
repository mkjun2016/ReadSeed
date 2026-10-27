import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import key_info_selector


class KeyInfoSelectorTest(unittest.TestCase):
    def test_select_keeps_only_valid_indices_and_respects_maximum(self):
        with tempfile.TemporaryDirectory() as directory:
            response = type("Response", (), {"raise_for_status": lambda self: None, "json": lambda self: {"content": [{"type": "text", "text": '{"indices":[1,99,1,0]}'}]}})()
            config = {"GLOSS_LLM_PROVIDER": "anthropic", "ANTHROPIC_API_KEY": "key", "GLOSS_LLM_MODEL": "test"}
            with (patch.dict(os.environ, config, clear=True), patch.object(key_info_selector, "CACHE_PATH", Path(directory) / "cache.sqlite3"), patch.object(key_info_selector.requests, "post", return_value=response)):
                result = key_info_selector.select(["첫 문장", "핵심 문장", "세 번째 문장"])
        self.assertEqual(result, [0])  # 세 문장은 최대 한 문장만 표시한다.

    def test_long_text_allows_one_key_sentence_per_five_sentences(self):
        with tempfile.TemporaryDirectory() as directory:
            response = type("Response", (), {"raise_for_status": lambda self: None, "json": lambda self: {"content": [{"type": "text", "text": '{"indices":[0,1,2,3,4]}'}]}})()
            config = {"GLOSS_LLM_PROVIDER": "anthropic", "ANTHROPIC_API_KEY": "key", "GLOSS_LLM_MODEL": "test"}
            with (patch.dict(os.environ, config, clear=True), patch.object(key_info_selector, "CACHE_PATH", Path(directory) / "cache.sqlite3"), patch.object(key_info_selector.requests, "post", return_value=response)):
                result = key_info_selector.select([f"문장 {index}" for index in range(20)])
        self.assertEqual(result, [0, 1, 2, 3])
