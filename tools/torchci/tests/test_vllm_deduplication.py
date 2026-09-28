"""Tests for the vLLM upstream review artifact and query helper."""

import json
import tempfile
import unittest
import urllib.error
from pathlib import Path
from typing import Any
from unittest import mock

from torchci import vllm_deduplication


def make_check(signature, status, count=1, issues=None, error=None):
    search = vllm_deduplication.IssueSearchResult(
        'repo:vllm-project/vllm is:issue "agent query"',
        count,
        list(issues or []),
        error,
    )
    return vllm_deduplication.CauseUpstreamCheck(
        signature,
        vllm_deduplication.UpstreamStatus(status),
        [search],
    )


class TestQueryInterface(unittest.TestCase):
    def test_agent_query_is_scoped_and_returns_raw_issue_details(self):
        payload = {
            "total_count": 1,
            "items": [
                {
                    "html_url": "https://github.com/vllm-project/vllm/issues/123",
                    "title": "NIXL issue",
                    "state": "open",
                    "body": "Details for the agent to review.",
                }
            ],
        }

        class Response:
            def __enter__(self):
                return self

            def __exit__(
                self, exc_type: Any, exc_value: Any, traceback: Any
            ) -> bool:
                return False

            def read(self):
                return json.dumps(payload).encode()

        with mock.patch.object(
            vllm_deduplication.urllib.request,
            "urlopen",
            return_value=Response(),
        ) as request:
            result = vllm_deduplication.query_upstream_issues(
                '"nixl_ep"', "token"
            )

        request.assert_called_once()
        sent_request = request.call_args.args[0]
        self.assertIn(
            "repo%3Avllm-project%2Fvllm+is%3Aissue+%22nixl_ep%22",
            sent_request.full_url,
        )
        self.assertEqual(sent_request.get_header("Authorization"), "Bearer token")
        self.assertEqual(result, payload)
        self.assertEqual(result["items"][0]["body"], "Details for the agent to review.")

    def test_bad_query_and_request_fail_immediately(self):
        with self.assertRaises(ValueError):
            vllm_deduplication.scope_upstream_query("  ")

        with mock.patch.object(
            vllm_deduplication.urllib.request,
            "urlopen",
            side_effect=urllib.error.URLError("rate limited"),
        ):
            with self.assertRaises(urllib.error.URLError):
                vllm_deduplication.query_upstream_issues(
                    "nixl_ep", "token"
                )


class TestAgentReviewResults(unittest.TestCase):
    def test_agent_can_record_hit_no_hit_and_incomplete_reviews(self):
        issue = vllm_deduplication.UpstreamIssueHit(
            "https://github.com/vllm-project/vllm/issues/123",
            "Related NIXL issue",
            "open",
            "The issue describes the same NIXL extension failure.",
        )
        artifact = vllm_deduplication.build_upstream_checks(
            [
                make_check(
                    "cause-1",
                    "upstream_candidates",
                    count=20,
                    issues=[issue],
                ),
                make_check("cause-2", "no_hits", count=20),
                make_check(
                    "cause-3", "search_incomplete", count=None, error="rate limited"
                ),
            ]
        )

        self.assertEqual(
            [check.status for check in artifact.checks],
            [
                vllm_deduplication.UpstreamStatus.UPSTREAM_CANDIDATES,
                vllm_deduplication.UpstreamStatus.NO_HITS,
                vllm_deduplication.UpstreamStatus.SEARCH_INCOMPLETE,
            ],
        )
        self.assertEqual(artifact.checks[0].searches[0].issues[0].reason, issue.reason)


class TestArtifactConversion(unittest.TestCase):
    def test_file_round_trip_builds_nested_dataclasses(self):
        issue = vllm_deduplication.UpstreamIssueHit(
            "https://github.com/vllm-project/vllm/issues/123",
            "Related NIXL issue",
            "open",
            "The issue describes the same NIXL extension failure.",
        )
        artifact = vllm_deduplication.build_upstream_checks(
            [make_check("cause-1", "upstream_candidates", issues=[issue])]
        )

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "upstream-checks.json"
            vllm_deduplication.write_upstream_checks(path, artifact)
            encoded = json.loads(path.read_text())
            loaded = vllm_deduplication.read_upstream_checks(path)

        self.assertNotIn("cause_key", encoded["checks"][0])
        self.assertEqual(loaded, artifact)

    def test_invalid_nested_artifact_data_fails(self):
        raw = {
                "checks": [
                {
                    "cause_signature": "cause-1",
                    "status": "upstream_candidates",
                    "searches": [
                        {
                            "query": "agent query",
                            "total_count": 1,
                            "issues": [
                                {
                                    "url": "https://github.com/vllm-project/vllm/pull/1",
                                    "title": "not an issue",
                                    "state": "open",
                                    "reason": "The issue describes the same failure.",
                                }
                            ],
                            "error": None,
                        }
                    ],
                }
            ]
        }

        with self.assertRaises(ValueError):
            vllm_deduplication.UpstreamChecksArtifact.from_dict(raw)


class TestArtifactInvariants(unittest.TestCase):
    def test_cause_signatures_must_be_unique(self):
        check = make_check("cause-1", "no_hits")
        with self.assertRaisesRegex(ValueError, "cause_signature"):
            vllm_deduplication.build_upstream_checks([check, check])

    def test_failed_review_cannot_be_written_as_no_hits(self):
        check = make_check(
            "cause-1", "search_incomplete", count=None, error="rate limited"
        )
        with self.assertRaises(ValueError):
            vllm_deduplication.CauseUpstreamCheck(
                check.cause_signature,
                vllm_deduplication.UpstreamStatus.NO_HITS,
                check.searches,
            )


if __name__ == "__main__":
    unittest.main()
