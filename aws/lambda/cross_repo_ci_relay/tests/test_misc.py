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

    def test_push_deleted_ciflow_trunk_ref_ignored(self):
        """Deleting the ciflow/trunk/<pr> tag (e.g. label removed, PR closed)
        reports the null SHA with the ref unchanged -- must not be treated
        as a real (pr_number, head_sha), or GitHub 422s on the fake SHA."""
        envelope = {
            "payload": {
                "ref": "refs/tags/ciflow/trunk/42",
                "after": "0" * 40,
                "deleted": True,
            }
        }
        self.assertEqual(extract_pr_context(envelope), ("", ""))
