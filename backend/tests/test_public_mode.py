import os
import unittest
from unittest.mock import patch

import asyncio
from types import SimpleNamespace

import ai_budget
import api
import gloss_selector


class DailyBudgetTest(unittest.TestCase):
    def setUp(self):
        ai_budget.reset()

    def tearDown(self):
        ai_budget.reset()

    def test_no_limit_by_default(self):
        with patch.dict(os.environ, {"AI_DAILY_LIMIT": ""}):
            self.assertTrue(all(ai_budget.take() for _ in range(50)))

    def test_stops_at_limit(self):
        with patch.dict(os.environ, {"AI_DAILY_LIMIT": "2"}):
            self.assertEqual([ai_budget.take() for _ in range(3)], [True, True, False])
            self.assertEqual(ai_budget.status(), {"used": 2, "limit": 2})

    def test_exhausted_budget_skips_claude_without_opening_circuit(self):
        gloss_selector.reset_circuit()
        with patch.dict(os.environ, {"AI_DAILY_LIMIT": "1"}), patch("gloss_selector.requests.post") as post:
            ai_budget.take()
            self.assertIsNone(gloss_selector._post_with_retry("https://example.invalid", {}, {}))
        post.assert_not_called()
        self.assertFalse(gloss_selector.circuit_open())


def fake_request(path, peer="127.0.0.1", headers=None):
    return SimpleNamespace(method="POST", url=SimpleNamespace(path=path), client=SimpleNamespace(host=peer), headers=headers or {})


class RateLimitTest(unittest.TestCase):
    def setUp(self):
        api._hits.clear()

    def run_middleware(self, request):
        async def call_next(_request):
            return "passed"
        return asyncio.run(api.limit_requests(request, call_next))

    def test_limits_each_visitor_separately(self):
        with patch.object(api, "RATE_LIMIT_PER_MINUTE", 2):
            first = [self.run_middleware(fake_request("/annotate", headers={"cf-connecting-ip": "1.1.1.1"})) for _ in range(3)]
            other = self.run_middleware(fake_request("/annotate", headers={"cf-connecting-ip": "2.2.2.2"}))
        self.assertEqual(first[:2], ["passed", "passed"])
        self.assertEqual(first[2].status_code, 429)
        self.assertEqual(other, "passed")

    def test_no_limit_when_unset(self):
        with patch.object(api, "RATE_LIMIT_PER_MINUTE", 0):
            self.assertTrue(all(self.run_middleware(fake_request("/annotate")) == "passed" for _ in range(20)))

    def test_forwarded_address_is_ignored_from_remote_peers(self):
        self.assertEqual(api._client_ip(fake_request("/annotate", peer="203.0.113.9", headers={"cf-connecting-ip": "1.1.1.1"})), "203.0.113.9")
        self.assertEqual(api._client_ip(fake_request("/annotate", headers={"cf-connecting-ip": "1.1.1.1"})), "1.1.1.1")

    def test_rejects_oversized_ocr_upload_before_reading(self):
        response = self.run_middleware(fake_request("/ocr", headers={"content-length": str(api.MAX_IMAGE_BYTES + 1)}))
        self.assertEqual(response.status_code, 413)


if __name__ == "__main__":
    unittest.main()
