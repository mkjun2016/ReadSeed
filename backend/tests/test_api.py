import sys
import types
import unittest
from unittest.mock import patch

import requests
from fastapi import HTTPException

import api


class ApiTest(unittest.TestCase):
    def test_health(self):
        self.assertEqual(api.health(), {"status": "ok"})

    def test_annotate_strips_sentence_and_returns_pipeline_result(self):
        expected = [{"어절": "같이", "발음": "가치"}]
        received = []

        def annotate_sentence(sentence):
            received.append(sentence)
            return expected

        with self.fake_pipeline(annotate_sentence):
            result = api.annotate(api.AnnotateRequest(sentence="  같이  "))

        self.assertEqual(received, ["같이"])
        self.assertIs(result, expected)

    def test_annotate_rejects_whitespace_only_sentence(self):
        with self.assertRaises(HTTPException) as raised:
            api.annotate(api.AnnotateRequest(sentence="   \t"))

        self.assertEqual(raised.exception.status_code, 422)
        self.assertEqual(raised.exception.detail, "sentence must not be empty")

    def test_annotate_maps_configuration_error_to_503(self):
        with self.fake_pipeline(self.raise_error(RuntimeError("missing key"))):
            with self.assertRaises(HTTPException) as raised:
                api.annotate(api.AnnotateRequest(sentence="같이"))

        self.assertEqual(raised.exception.status_code, 503)
        self.assertEqual(raised.exception.detail, "missing key")

    def test_annotate_maps_timeout_to_504(self):
        with self.fake_pipeline(self.raise_error(requests.exceptions.Timeout())):
            with self.assertRaises(HTTPException) as raised:
                api.annotate(api.AnnotateRequest(sentence="같이"))

        self.assertEqual(raised.exception.status_code, 504)
        self.assertEqual(raised.exception.detail, "external API timed out")

    def test_annotate_maps_request_failure_to_502(self):
        with self.fake_pipeline(self.raise_error(requests.exceptions.ConnectionError())):
            with self.assertRaises(HTTPException) as raised:
                api.annotate(api.AnnotateRequest(sentence="같이"))

        self.assertEqual(raised.exception.status_code, 502)
        self.assertEqual(raised.exception.detail, "external API request failed")

    def test_annotate_hides_unexpected_error_details(self):
        with self.fake_pipeline(self.raise_error(ValueError("private detail"))):
            with self.assertRaises(HTTPException) as raised:
                api.annotate(api.AnnotateRequest(sentence="같이"))

        self.assertEqual(raised.exception.status_code, 500)
        self.assertEqual(raised.exception.detail, "annotation failed")

    @staticmethod
    def fake_pipeline(annotate_sentence):
        module = types.ModuleType("pipeline")
        module.annotate_sentence = annotate_sentence
        return patch.dict(sys.modules, {"pipeline": module})

    @staticmethod
    def raise_error(error):
        def raiser(_sentence):
            raise error

        return raiser


if __name__ == "__main__":
    unittest.main()
