"""Tests for the red->red test-set regression gap in the nightly triage.

Inputs are small, hand-written pytest bodies (see make_pytest_body), never
captured logs: the parser is already trusted, so each case isolates exactly one
diff/compare behaviour.
"""

import email.message
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

import torchci.vllm_torch_nightly_triage as triage
from torchci.vllm_log_parser import parse_log
from torchci.vllm_torch_nightly_triage import diff_failing_tests


def _both_job(name, tn_body_url, baseline_url):
    return {
        "name": name,
        "state": "failed",
        "exit_status": 1,
        "url": tn_body_url,
        "agent": "agent-1",
        "baseline_state": "failed",
        "baseline_url": baseline_url,
    }


def make_pytest_body(failures, duration="1.23s"):
    """Build a minimal parseable pytest tail from failure tuples.

    Each failure is ``(test_id, exception_class, message)``. An empty
    exception_class yields a bare ``FAILED`` line (no class on the summary line),
    which parse_log leaves with an empty pytest_exception_class.
    """
    lines = [
        "=========================== short test summary info ============================"
    ]
    for test_id, exception_class, message in failures:
        if not exception_class:
            lines.append(f"FAILED {test_id}")
        elif message:
            lines.append(f"FAILED {test_id} - {exception_class}: {message}")
        else:
            lines.append(f"FAILED {test_id} - {exception_class}")
    lines.append(
        f"===================== {len(failures)} failed in {duration} ====================="
    )
    return "\n".join(lines)


class TestMakePytestBody(unittest.TestCase):
    def test_body_parses_to_expected_failures(self) -> None:
        body = make_pytest_body(
            [
                ("tests/test_a.py::test_foo", "AssertionError", "1 == 2"),
                ("tests/test_b.py::test_bar", "ValueError", "boom"),
            ]
        )
        parsed = parse_log(body)
        failures = [
            failure
            for result in parsed.pytest_results
            for failure in result.test_failures
        ]
        self.assertEqual(len(failures), 2)
        by_id = {failure.test_id: failure for failure in failures}
        self.assertEqual(
            by_id["tests/test_a.py::test_foo"].pytest_exception_class, "AssertionError"
        )
        self.assertEqual(
            by_id["tests/test_b.py::test_bar"].pytest_exception_class, "ValueError"
        )

    def test_bare_failed_leaves_class_empty(self) -> None:
        body = make_pytest_body([("tests/test_c.py::test_baz", "", "")])
        parsed = parse_log(body)
        failure = parsed.pytest_results[0].test_failures[0]
        self.assertEqual(failure.test_id, "tests/test_c.py::test_baz")
        self.assertEqual(failure.pytest_exception_class, "")

    def test_summary_count_matches(self) -> None:
        body = make_pytest_body(
            [
                ("tests/test_a.py::test_one", "ValueError", "bad"),
                ("tests/test_a.py::test_two", "TypeError", "wrong"),
            ]
        )
        parsed = parse_log(body)
        self.assertEqual(parsed.pytest_results[0].expected_test_failure_count, 2)


class TestDiffFailingTests(unittest.TestCase):
    def test_identical_bodies_all_shared(self) -> None:
        body = make_pytest_body(
            [
                ("tests/test_a.py::test_foo", "AssertionError", "1 == 2"),
                ("tests/test_b.py::test_bar", "ValueError", "boom"),
            ]
        )
        diff = diff_failing_tests(body, body)
        self.assertEqual(diff.skipped, "")
        self.assertEqual(diff.new_failures, [])
        self.assertEqual(len(diff.shared_failures), 2)

    def test_extra_nightly_failure_is_new(self) -> None:
        torch_nightly = make_pytest_body(
            [
                ("tests/test_a.py::test_foo", "AssertionError", "nightly says 1 == 2"),
                ("tests/test_b.py::test_bar", "ValueError", "nightly boom"),
            ]
        )
        baseline = make_pytest_body(
            [
                ("tests/test_a.py::test_foo", "AssertionError", "baseline says 1 == 2"),
            ]
        )
        diff = diff_failing_tests(torch_nightly, baseline)
        self.assertEqual(diff.skipped, "")
        self.assertEqual(len(diff.new_failures), 1)
        self.assertEqual(diff.new_failures[0].test_id, "tests/test_b.py::test_bar")

        self.assertEqual(len(diff.shared_failures), 1)
        nightly_side, baseline_side = diff.shared_failures[0]
        self.assertEqual(nightly_side.test_id, "tests/test_a.py::test_foo")
        self.assertEqual(baseline_side.test_id, "tests/test_a.py::test_foo")
        # Both chains are recorded raw for the agent, never compared.
        self.assertIn("nightly says 1 == 2", nightly_side.exception_chain)
        self.assertIn("baseline says 1 == 2", baseline_side.exception_chain)

    def test_changed_exception_class_is_new(self) -> None:
        torch_nightly = make_pytest_body(
            [("tests/test_a.py::test_foo", "TypeError", "wrong type")]
        )
        baseline = make_pytest_body(
            [("tests/test_a.py::test_foo", "ValueError", "bad value")]
        )
        diff = diff_failing_tests(torch_nightly, baseline)
        self.assertEqual(diff.skipped, "")
        self.assertEqual(len(diff.new_failures), 1)
        self.assertEqual(diff.new_failures[0].pytest_exception_class, "TypeError")
        self.assertEqual(diff.shared_failures, [])


class TestDiffFailClosed(unittest.TestCase):
    """A broken diff never emits new failures -- it sets `skipped`."""

    def test_no_pytest_session_either_side_skips(self) -> None:
        no_session = "Step 1: building wheel...\nBuild failed.\n"
        good = make_pytest_body([("tests/test_a.py::test_foo", "ValueError", "boom")])

        diff_nightly_broken = diff_failing_tests(no_session, good)
        self.assertNotEqual(diff_nightly_broken.skipped, "")
        self.assertEqual(diff_nightly_broken.new_failures, [])

        diff_baseline_broken = diff_failing_tests(good, no_session)
        self.assertNotEqual(diff_baseline_broken.skipped, "")
        self.assertEqual(diff_baseline_broken.new_failures, [])

    def test_parse_raises_skips(self) -> None:
        good = make_pytest_body([("tests/test_a.py::test_foo", "ValueError", "boom")])
        with mock.patch.object(triage, "parse_log", side_effect=RuntimeError("boom")):
            diff = diff_failing_tests(good, good)
        self.assertNotEqual(diff.skipped, "")
        self.assertEqual(diff.new_failures, [])


class TestCompareCarriesBaselineUrl(unittest.TestCase):
    """A `both`-bucket job must carry the baseline-side web_url for log fetch."""

    def test_both_job_has_baseline_url(self) -> None:
        # Column order matches the compare() SELECT:
        # job_name, shard, tn_state, tn_exit, tn_url, tn_agent,
        # base_state, base_url, in_tn, in_base
        row = (
            "Job A",
            0,
            "failed",
            1,
            "https://buildkite/tn#job",
            "agent-1",
            "failed",
            "https://buildkite/base#job",
            1,
            1,
        )
        with mock.patch.object(triage, "_rows", return_value=[row]):
            buckets = triage.compare(client=None, tn_number=82789, base_number=82790)
        self.assertEqual(len(buckets["both"]), 1)
        both_job = buckets["both"][0]
        self.assertEqual(both_job["url"], "https://buildkite/tn#job")
        self.assertEqual(both_job["baseline_url"], "https://buildkite/base#job")
        self.assertEqual(both_job["baseline_state"], "failed")


def _superset_fetched(cluster="Job A"):
    """A fetched cluster whose nightly failing set is a superset of baseline's."""
    rep = _both_job(cluster, "tn#job", "base#job")
    torch_nightly_body = make_pytest_body(
        [
            ("tests/test_a.py::test_foo", "AssertionError", "boom"),
            ("tests/test_b.py::test_bar", "ValueError", "new failure"),
        ]
    )
    baseline_body = make_pytest_body(
        [("tests/test_a.py::test_foo", "AssertionError", "boom")]
    )
    return [(cluster, rep, torch_nightly_body, baseline_body)]


class TestDiffBothClusters(unittest.TestCase):
    """The pure diff stage surfaces the extra nightly failures per cluster."""

    def test_superset_nightly_surfaces_new_failure(self) -> None:
        cluster_diffs = triage.diff_both_clusters(_superset_fetched())
        self.assertEqual(len(cluster_diffs), 1)
        cluster_diff = cluster_diffs[0]
        self.assertEqual(cluster_diff.cluster, "Job A")
        new_ids = [failure.test_id for failure in cluster_diff.diff.new_failures]
        self.assertEqual(new_ids, ["tests/test_b.py::test_bar"])

    def test_entry_carries_cluster_and_baseline_url(self) -> None:
        [cluster_diff] = triage.diff_both_clusters(_superset_fetched())
        entry = triage._build_regressed_entry(
            cluster_diff.cluster, cluster_diff.rep, cluster_diff.diff
        )
        self.assertEqual(entry["cluster"], "Job A")
        self.assertEqual(entry["baseline_url"], "base#job")
        new_ids = [nf["test_id"] for nf in entry["new_failures"]]
        self.assertEqual(new_ids, ["tests/test_b.py::test_bar"])

    def test_no_new_failures_dropped(self) -> None:
        rep = _both_job("Job A", "tn#job", "base#job")
        body = make_pytest_body(
            [("tests/test_a.py::test_foo", "AssertionError", "shared boom")]
        )
        self.assertEqual(triage.diff_both_clusters([("Job A", rep, body, body)]), [])


class TestWriteBothArtifacts(unittest.TestCase):
    """The write stage emits one artifact per surfaced cluster with shared chains."""

    def _artifacts_for(self, torch_nightly_body, baseline_body):
        rep = _both_job("Job A", "tn#job", "base#job")
        cluster_diffs = triage.diff_both_clusters(
            [("Job A", rep, torch_nightly_body, baseline_body)]
        )
        with tempfile.TemporaryDirectory() as tmp:
            written = triage._write_both_artifacts(
                cluster_diffs, Path(tmp), tail_lines=50
            )
            contents = [Path(path).read_text() for path in written]
        return written, contents

    def test_new_failures_write_artifact_with_shared_chains(self) -> None:
        torch_nightly_body = make_pytest_body(
            [
                ("tests/test_a.py::test_foo", "AssertionError", "shared boom"),
                ("tests/test_b.py::test_bar", "ValueError", "new-failure-marker"),
            ]
        )
        baseline_body = make_pytest_body(
            [("tests/test_a.py::test_foo", "AssertionError", "baseline-only-marker")]
        )
        written, contents = self._artifacts_for(torch_nightly_body, baseline_body)

        self.assertEqual(len(written), 1)
        artifact = contents[0]
        self.assertIn("red on both sides", artifact)
        self.assertIn("tests/test_b.py::test_bar", artifact)  # the new failure
        self.assertIn("new-failure-marker", artifact)
        # The shared section records the baseline chain, not just the nightly one.
        self.assertIn("baseline-only-marker", artifact)

    def test_no_surfaced_clusters_writes_nothing(self) -> None:
        self.assertEqual(triage._write_both_artifacts([], Path("/nonexistent"), 50), [])


def _regressed_entry():
    return {
        "name": "Job A",
        "cluster": "Job A",
        "url": "https://buildkite/tn#job",
        "baseline_url": "https://buildkite/base#job",
        "state": "failed",
        "baseline_state": "failed",
        "new_failures": [
            {
                "test_id": "tests/test_b.py::test_bar",
                "exception_class": "ValueError",
                "torch_nightly_exception_chain": "ValueError: new-failure-marker",
            }
        ],
        "shared_failures": [
            {
                "test_id": "tests/test_a.py::test_foo",
                "exception_class": "AssertionError",
                "torch_nightly_exception_chain": "AssertionError: shared",
                "baseline_exception_chain": "AssertionError: shared",
            }
        ],
    }


class TestRenderRegressedTests(unittest.TestCase):
    """render() surfaces the test-set regressions even when no job flipped green->red."""

    def _tn_base(self):
        tn = {
            "number": 82789,
            "url": "u_tn",
            "state": "failed",
            "commit": "b706fd1628b0abcdef",
        }
        base = {
            "number": 82790,
            "url": "u_base",
            "state": "failed",
            "commit": "b706fd1628b0abcdef",
        }
        return tn, base

    def test_section_present_when_regressed_tests(self) -> None:
        tn, base = self._tn_base()
        buckets = {"regressed": [], "both": [], "baseline_only": []}
        out = triage.render(tn, base, buckets, [_regressed_entry()])
        self.assertIn("Test-set regressions", out)
        self.assertIn("tests/test_b.py::test_bar", out)
        self.assertIn("ValueError", out)
        # The shared count rides along as context.
        self.assertIn("1 shared", out)

    def test_no_section_when_empty(self) -> None:
        tn, base = self._tn_base()
        buckets = {"regressed": [], "both": [], "baseline_only": []}
        out = triage.render(tn, base, buckets, [])
        self.assertNotIn("Test-set regressions", out)


class TestReportJsonWiring(unittest.TestCase):
    """main() writes a regressed_tests array into report.json."""

    def test_json_has_regressed_tests_key(self) -> None:
        import json
        import os

        tn = {
            "number": 82789,
            "url": "u_tn",
            "state": "failed",
            "commit": "b706fd1628b0abcdef",
        }
        base = {
            "number": 82790,
            "url": "u_base",
            "state": "failed",
            "commit": "b706fd1628b0abcdef",
        }
        # A `both` job so main() decides to fetch logs (the diff path).
        buckets = {
            "regressed": [],
            "both": [_both_job("Job A", "u_tn#job", "u_base#job")],
            "baseline_only": [],
        }

        def _fake_fetch_cluster_logs(
            buckets_arg,
            logs_dir,
            token,
            tail_lines,
            torch_versions=None,
            regressed_tests=None,
        ):
            if regressed_tests is not None:
                regressed_tests.append(_regressed_entry())
            return []

        with tempfile.TemporaryDirectory() as tmp:
            json_path = f"{tmp}/report.json"
            logs_dir = f"{tmp}/logs"
            argv = [
                "prog",
                "--json-output",
                json_path,
                "--logs-dir",
                logs_dir,
                "--output",
                f"{tmp}/report.md",
            ]
            with mock.patch.object(triage.sys, "argv", argv), mock.patch.object(
                triage, "get_clickhouse_client", return_value=object()
            ), mock.patch.object(
                triage, "find_latest_pair", return_value=(tn, base)
            ), mock.patch.object(
                triage, "compare", return_value=buckets
            ), mock.patch.object(
                triage, "fetch_cluster_logs", side_effect=_fake_fetch_cluster_logs
            ), mock.patch.dict(os.environ, {"BUILDKITE_TOKEN": "tok"}):
                rc = triage.main()
            self.assertEqual(rc, 0)
            with open(json_path) as f:
                report = json.load(f)
        self.assertIn("regressed_tests", report)
        self.assertEqual(len(report["regressed_tests"]), 1)
        self.assertEqual(
            report["regressed_tests"][0]["new_failures"][0]["test_id"],
            "tests/test_b.py::test_bar",
        )


class TestBaselineLogAvailabilityGuard(unittest.TestCase):
    """A baseline fetch failure fails closed -- the cluster is skipped, not surfaced.

    Without the guard a baseline 401/URLError would either crash the whole run or,
    worse, be swallowed into "every nightly failure is new."
    """

    def _fetch_with_baseline_error(self, error):
        tn_url = "https://buildkite/x/builds/82789#0197-tn"
        base_url = "https://buildkite/x/builds/82790#0197-base"
        torch_nightly_body = make_pytest_body(
            [("tests/test_a.py::test_foo", "AssertionError", "boom")]
        )

        def _fetch(job_url, token, timeout=120):
            if job_url == tn_url:
                return torch_nightly_body
            if job_url == base_url:
                raise error
            raise AssertionError(f"unexpected fetch url {job_url!r}")

        buckets = {
            "regressed": [],
            "both": [_both_job("Job A", tn_url, base_url)],
            "baseline_only": [],
        }
        with mock.patch.object(triage, "_fetch_job_log", side_effect=_fetch):
            return triage._fetch_both_clusters(buckets, token="tok")

    def test_baseline_401_skips_cluster(self) -> None:
        error = urllib.error.HTTPError(
            "http://x", 401, "Unauthorized", hdrs=email.message.Message(), fp=None
        )
        self.assertEqual(self._fetch_with_baseline_error(error), [])

    def test_baseline_urlerror_skips_cluster(self) -> None:
        self.assertEqual(
            self._fetch_with_baseline_error(
                urllib.error.URLError("connection refused")
            ),
            [],
        )


if __name__ == "__main__":
    unittest.main()
