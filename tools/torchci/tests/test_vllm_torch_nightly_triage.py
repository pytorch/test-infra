"""Tests for the torch-nightly regression detector, driven by a recorded fixture.

The fixture is the two raw ClickHouse result sets, captured with
``--record-clickhouse`` from the run that produced build pair 82789/82790
(https://github.com/pytorch/test-infra/actions/runs/31517070041). Replaying it
reproduces that run's report.md byte for byte, so these tests pin real behaviour
rather than hand-built rows.

Note report.json is *not* usable here: it holds the pipeline's output (the
regressed/both buckets), not the inputs, so it cannot exercise the pair selection
or bucketing that produced it.
"""

import unittest
from datetime import datetime
from pathlib import Path

from torchci.vllm_torch_nightly_triage import (
    agent_concentration,
    cluster_key,
    compare,
    find_latest_pair,
    render,
    ReplayClient,
)


FIXTURES_DIR = Path(__file__).parent / "fixtures"
FIXTURE = FIXTURES_DIR / "clickhouse_vllm_builds_jobs_82789.json"

# The pair the fixture was recorded around, and its bucket counts.
TORCH_NIGHTLY_BUILD = 82789
BASELINE_BUILD = 82790
COMMIT = "b706fd1628b06c216a945176a9fedfa808324803"


def client() -> ReplayClient:
    return ReplayClient.from_file(str(FIXTURE))


class TestReplayClient(unittest.TestCase):
    def test_routes_queries_by_table(self) -> None:
        c = client()
        builds = c.query("SELECT 1 FROM vllm.vllm_buildkite_builds FINAL")
        jobs = c.query("SELECT 1 FROM vllm.vllm_buildkite_jobs FINAL")
        self.assertNotEqual(builds.result_rows, jobs.result_rows)
        self.assertIn("number", builds.column_names)
        self.assertIn("job_name", jobs.column_names)

    def test_rejects_unknown_query(self) -> None:
        with self.assertRaises(ValueError):
            client().query("SELECT 1 FROM some.other_table")

    def test_datetimes_round_trip(self) -> None:
        """created_at must come back as a datetime; find_latest_pair subtracts them."""
        rows = client().query("SELECT 1 FROM vllm.vllm_buildkite_builds").result_rows
        created_at_index = 3
        self.assertTrue(rows)
        self.assertIsInstance(rows[0][created_at_index], datetime)


class TestFindLatestPair(unittest.TestCase):
    def test_selects_the_same_commit_pair(self) -> None:
        tn, base = find_latest_pair(client(), 14)
        self.assertEqual(tn["number"], TORCH_NIGHTLY_BUILD)
        self.assertEqual(base["number"], BASELINE_BUILD)
        self.assertEqual(tn["commit"], COMMIT)
        self.assertEqual(tn["commit"], base["commit"])

    def test_prefers_the_plain_nightly_over_the_daily(self) -> None:
        _, base = find_latest_pair(client(), 14)
        self.assertTrue(base["title"].startswith("Full CI run - nightly"))

    def test_skips_newer_torch_nightlies_that_have_no_sibling(self) -> None:
        """The newest torch-nightly is not always the answer.

        This fixture holds two off-schedule torch-nightly builds (#83338, #83159)
        newer than the pair, neither with a same-commit baseline. Taking
        nightlies[0] would return None and report nothing; the walk must continue
        past them. Guards the loop in find_latest_pair against being simplified.
        """
        rows = client().query("SELECT 1 FROM vllm.vllm_buildkite_builds").result_rows
        title_index, number_index = 1, 0
        torch_nightlies = [
            r[number_index]
            for r in rows
            if str(r[title_index]).startswith("Full CI run torch nightly")
        ]
        self.assertGreater(max(torch_nightlies), TORCH_NIGHTLY_BUILD)

        tn, _ = find_latest_pair(client(), 14)
        self.assertEqual(tn["number"], TORCH_NIGHTLY_BUILD)


class TestCompare(unittest.TestCase):
    def setUp(self) -> None:
        self.buckets = compare(client(), TORCH_NIGHTLY_BUILD, BASELINE_BUILD)

    def test_bucket_counts(self) -> None:
        self.assertEqual(len(self.buckets["regressed"]), 26)
        self.assertEqual(len(self.buckets["both"]), 8)
        self.assertEqual(len(self.buckets["baseline_only"]), 4)

    def test_regressed_means_failed_here_and_passed_on_baseline(self) -> None:
        for job in self.buckets["regressed"]:
            self.assertIn(job["state"], ("failed", "timed_out"))
            self.assertEqual(job["baseline_state"], "passed")

    def test_both_bucket_fails_on_baseline_too(self) -> None:
        for job in self.buckets["both"]:
            self.assertIn(job["state"], ("failed", "timed_out"))
            self.assertIn(job["baseline_state"], ("failed", "timed_out"))

    def test_sharded_jobs_are_labelled_individually(self) -> None:
        """Shards of one job name disagree, so each needs its own row."""
        sharded = [j for j in self.buckets["regressed"] if "[shard " in j["name"]]
        self.assertTrue(sharded)
        self.assertEqual(len(sharded), len({j["name"] for j in sharded}))


class TestClusterKey(unittest.TestCase):
    def test_collapses_shard_suffix(self) -> None:
        self.assertEqual(
            cluster_key("Multi-Modal Processor 4"), "Multi-Modal Processor"
        )

    def test_collapses_hardware_qualifier(self) -> None:
        self.assertEqual(cluster_key("Fusion E2E TP2 (B200)"), "Fusion E2E TP2")

    def test_collapses_both(self) -> None:
        self.assertEqual(
            cluster_key("Multi-Modal Processor (CPU) 3"), "Multi-Modal Processor"
        )

    def test_never_returns_empty(self) -> None:
        self.assertEqual(cluster_key("(B200)"), "(B200)")

    def test_fixture_regressions_collapse_into_fewer_clusters(self) -> None:
        buckets = compare(client(), TORCH_NIGHTLY_BUILD, BASELINE_BUILD)
        clusters = {cluster_key(j["name"]) for j in buckets["regressed"]}
        self.assertEqual(len(clusters), 25)
        self.assertLess(len(clusters), len(buckets["regressed"]))


class TestRender(unittest.TestCase):
    def setUp(self) -> None:
        self.tn, self.base = find_latest_pair(client(), 14)
        self.buckets = compare(client(), self.tn["number"], self.base["number"])
        self.report = render(self.tn, self.base, self.buckets)

    def test_headline_counts_the_regressions(self) -> None:
        self.assertIn("**26 job(s) regressed**", self.report)

    def test_links_both_builds_and_the_shared_commit(self) -> None:
        self.assertIn(f"#{TORCH_NIGHTLY_BUILD}", self.report)
        self.assertIn(f"#{BASELINE_BUILD}", self.report)
        self.assertIn(COMMIT[:12], self.report)

    def test_reports_no_single_agent_concentration(self) -> None:
        """22 agents carry 26 failures here, so this is real signal, not a sick host."""
        agents = agent_concentration(self.buckets["regressed"])
        self.assertEqual(len(agents), 22)
        self.assertLess(agents[0][1] / len(self.buckets["regressed"]), 0.5)
        self.assertIn("No single-host concentration", self.report)


if __name__ == "__main__":
    unittest.main()
