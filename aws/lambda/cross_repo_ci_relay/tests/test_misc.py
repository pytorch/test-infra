import unittest

from utils.misc import extract_pr_context


class TestExtractPrContext(unittest.TestCase):
    def test_pull_request_event(self):
        envelope = {
            "payload": {"pull_request": {"number": 42, "head": {"sha": "abc123"}}}
        }
        self.assertEqual(extract_pr_context(envelope), ("42", "abc123"))

    def test_push_ciflow_trunk_ref(self):
        envelope = {
            "payload": {"ref": "refs/tags/ciflow/trunk/12345", "after": "def456"}
        }
        self.assertEqual(extract_pr_context(envelope), ("12345", "def456"))

    def test_push_non_ciflow_ref(self):
        envelope = {"payload": {"ref": "refs/heads/main", "after": "def456"}}
        self.assertEqual(extract_pr_context(envelope), ("", "def456"))
