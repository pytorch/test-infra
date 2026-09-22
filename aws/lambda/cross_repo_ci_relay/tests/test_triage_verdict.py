import unittest

from utils.triage_verdict import (
    MAX_EVIDENCE_ENTRIES,
    MAX_EXCERPT_LEN,
    MAX_RAW_BYTES,
    MAX_SUMMARY_LEN,
    validate_triage_verdict,
)


def _verdict(**overrides):
    base = {
        "schema_version": 1,
        "category": "upstream",
        "confidence": "high",
        "summary": "aten::foo lost its out= overload in #194610.",
        "suspected_upstream": {
            "pr": 194610,
            "commit": "0e797b5a6acf",
            "reason": "signature change to aten::foo",
        },
        "evidence": [
            {
                "job": "build-npu",
                "test": "test_foo_out_variant",
                "log_url": "https://example.com/job/123#step:5:2007",
                "excerpt": "error: no matching function for call to 'foo'",
            }
        ],
        "reproduced_on_retry": False,
        "analyzer": {
            "name": "ascend-ci-triage",
            "version": "0.3.1",
            "model": "claude-haiku-4-5",
            "prompt_version": "2026-08-20",
        },
        "analyzed_at": "2026-08-24T14:22:10Z",
    }
    base.update(overrides)
    return base


class TestValidateTriageVerdict(unittest.TestCase):
    def test_full_verdict_round_trips(self):
        self.assertEqual(validate_triage_verdict(_verdict()), _verdict())

    def test_minimal_verdict(self):
        raw = {
            "schema_version": 1,
            "category": "flake",
            "confidence": "low",
            "summary": "timed out waiting for the device",
        }
        self.assertEqual(validate_triage_verdict(raw), raw)

    def test_absent_verdict_is_not_an_error(self):
        self.assertIsNone(validate_triage_verdict(None))

    def test_unknown_keys_are_dropped_not_rejected(self):
        # Forward compatibility: an analyzer emitting an additive field still
        # validates, it just does not get that field persisted.
        result = validate_triage_verdict(_verdict(future_field={"a": 1}))
        self.assertIsNotNone(result)
        self.assertNotIn("future_field", result)

    def test_numeric_string_schema_version_accepted(self):
        self.assertIsNotNone(
            validate_triage_verdict(_verdict(schema_version="1")),
        )

    def test_structural_violations_drop_the_whole_verdict(self):
        for name, raw in [
            ("not an object", "upstream"),
            ("unknown schema_version", _verdict(schema_version=2)),
            ("bool schema_version", _verdict(schema_version=True)),
            (
                "missing schema_version",
                {k: v for k, v in _verdict().items() if k != "schema_version"},
            ),
            ("unknown category", _verdict(category="cosmic-rays")),
            ("unknown confidence", _verdict(confidence="0.9")),
            (
                "missing summary",
                {k: v for k, v in _verdict().items() if k != "summary"},
            ),
            ("empty summary", _verdict(summary="   ")),
            ("non-string summary", _verdict(summary=True)),
            ("non-bool reproduced_on_retry", _verdict(reproduced_on_retry="false")),
            ("evidence not a list", _verdict(evidence={"job": "x"})),
            ("evidence entry not an object", _verdict(evidence=["build-npu"])),
            ("analyzer not an object", _verdict(analyzer="ascend-ci-triage")),
            ("analyzed_at not a timestamp", _verdict(analyzed_at="last tuesday")),
        ]:
            with self.subTest(name):
                self.assertIsNone(validate_triage_verdict(raw))

    def test_suspected_upstream_only_valid_for_upstream_category(self):
        # A `backend` verdict naming an upstream culprit contradicts itself, so
        # no part of it is trustworthy enough to render.
        self.assertIsNone(
            validate_triage_verdict(
                _verdict(category="backend", suspected_upstream={"pr": 194610})
            )
        )

    def test_suspected_upstream_must_name_a_pr_or_commit(self):
        self.assertIsNone(
            validate_triage_verdict(
                _verdict(suspected_upstream={"reason": "vibes"}),
            )
        )

    def test_suspected_upstream_field_types(self):
        for name, suspected in [
            ("pr as a string", {"pr": "194610"}),
            ("pr as a bool", {"pr": True}),
            ("pr not positive", {"pr": 0}),
            ("commit not hex", {"commit": "not-a-sha"}),
            ("commit too short", {"commit": "0e797b"}),
        ]:
            with self.subTest(name):
                self.assertIsNone(
                    validate_triage_verdict(_verdict(suspected_upstream=suspected))
                )

    def test_commit_only_suspicion_is_accepted(self):
        result = validate_triage_verdict(
            _verdict(suspected_upstream={"commit": "0e797b5a6acf"})
        )
        self.assertEqual(result["suspected_upstream"], {"commit": "0e797b5a6acf"})

    def test_non_http_log_url_drops_the_verdict(self):
        self.assertIsNone(
            validate_triage_verdict(
                _verdict(evidence=[{"log_url": "javascript:alert(1)"}])
            )
        )

    def test_malicious_log_url_shapes_drop_the_verdict(self):
        for name, log_url in [
            ("userinfo spoofing", "https://github.com@evil.com/log"),
            (
                "embedded newline and markdown link",
                "https://ok.com\n\n[Click to approve](https://evil.com)",
            ),
            (
                "embedded space before scheme-like text",
                "https://ok.com/ javascript:alert(1)",
            ),
            ("space after scheme", "https:// evil.com"),
            ("no host", "https://"),
        ]:
            with self.subTest(name):
                self.assertIsNone(
                    validate_triage_verdict(_verdict(evidence=[{"log_url": log_url}]))
                )

    def test_long_summary_is_truncated_not_rejected(self):
        result = validate_triage_verdict(
            _verdict(summary="x" * (MAX_SUMMARY_LEN + 500))
        )
        self.assertEqual(len(result["summary"]), MAX_SUMMARY_LEN)

    def test_long_excerpt_is_truncated_not_rejected(self):
        result = validate_triage_verdict(
            _verdict(
                evidence=[
                    {"job": "build-npu", "excerpt": "y" * (MAX_EXCERPT_LEN + 500)}
                ]
            )
        )
        self.assertEqual(len(result["evidence"][0]["excerpt"]), MAX_EXCERPT_LEN)

    def test_extra_evidence_entries_are_dropped_not_rejected(self):
        result = validate_triage_verdict(
            _verdict(
                evidence=[
                    {"job": f"job-{i}", "excerpt": "boom"}
                    for i in range(MAX_EVIDENCE_ENTRIES + 5)
                ]
            )
        )
        self.assertEqual(len(result["evidence"]), MAX_EVIDENCE_ENTRIES)
        self.assertEqual(result["evidence"][0]["job"], "job-0")

    def test_verdict_over_the_raw_byte_cap_is_dropped(self):
        # Past a point the caps stop being enough on their own: many oversized
        # values still add up, so the whole object is bounded too.
        self.assertIsNone(
            validate_triage_verdict(
                _verdict(evidence=[{"job": "j", "excerpt": "z" * MAX_RAW_BYTES}])
            )
        )

    def test_empty_evidence_and_analyzer_are_omitted(self):
        result = validate_triage_verdict(_verdict(evidence=[], analyzer={}))
        self.assertNotIn("evidence", result)
        self.assertNotIn("analyzer", result)


if __name__ == "__main__":
    unittest.main()
