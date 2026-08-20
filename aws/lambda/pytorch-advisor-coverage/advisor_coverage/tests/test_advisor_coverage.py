"""Unit tests for the advisor-coverage dispatcher (unclassified-red model).

Every ClickHouse / GitHub / S3 interaction is mocked; no network, no writes.
"""

import base64
import json
import logging
import time
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

from advisor_coverage import config as config_mod
from advisor_coverage.backfill import run_backfill
from advisor_coverage.config import (
    _parse_workflows,
    BACKFILL_MIN_DISPATCH_GAP_SECONDS,
    COVERAGE_SIGNAL_KEY_PREFIX,
    CoverageConfig,
    HARD_CAP_DISPATCHES,
)
from advisor_coverage.dispatcher import CoverageDispatcher
from advisor_coverage.enumeration import (
    BaselineCommit,
    JobRun,
    RedSignal,
    UnclassifiedRedEnumerator,
)
from advisor_coverage.payload import build_isolated_red_payload, coverage_signal_key


def T(minute: int) -> datetime:
    return datetime(2026, 1, 1, 12, minute, 0)


def make_config(**overrides) -> CoverageConfig:
    defaults = {
        "repo_full_name": "pytorch/pytorch",
        "workflows": [],
        "hours": 24,
        "max_dispatches_per_run": 10,
        "dispatch_gap_seconds": 3,
        "dry_run": True,
    }
    defaults.update(overrides)
    return CoverageConfig(**defaults)


def make_red(
    *,
    job_name="linux-jammy / test (slow)",
    run_name="linux-jammy / test (slow, 2, 3, mt-l-runner-a)",
    job_base_name=None,
    workflow="slow",
    observed="sha_observed_1",
    minute=30,
    commit_dt=None,
    job_id=9000,
    n_baselines=3,
) -> RedSignal:
    # job_name is the NORMALIZED key (feeds signal_key + dedup); run_name is the
    # concrete shard+runner run (feeds the payload events + log url). Production
    # sets job_base_name to the same normalized identity as job_name.
    base = commit_dt if commit_dt is not None else T(minute)
    job_base_name = job_base_name if job_base_name is not None else job_name
    suspect = JobRun(
        name=run_name,
        job_id=job_id,
        wf_run_id=job_id + 1,
        run_attempt=1,
        started_at=base,
        ended_at=base + timedelta(minutes=10),
    )
    baselines = [
        BaselineCommit(
            sha=f"sha_base_{i}",
            commit_time=base - timedelta(minutes=5 * (i + 1)),
            run=JobRun(
                name=run_name,
                job_id=job_id - 100 * (i + 1),
                wf_run_id=job_id - 100 * (i + 1) + 1,
                run_attempt=1,
                started_at=base - timedelta(minutes=5 * (i + 1)),
                ended_at=base - timedelta(minutes=5 * (i + 1) - 3),
            ),
        )
        for i in range(n_baselines)
    ]
    return RedSignal(
        observed_commit=observed,
        commit_time=base,
        workflow_name=workflow,
        job_name=job_name,
        job_base_name=job_base_name,
        suspect=suspect,
        baselines=baselines,
    )


def _minted(token: str, valid_for: timedelta) -> MagicMock:
    """A stand-in for PyGithub's InstallationAuthorization."""
    auth = MagicMock()
    auth.token = token
    auth.expires_at = datetime.now(timezone.utc) + valid_for
    return auth


def _auth_expiring_in(remaining: timedelta):
    from advisor_coverage.bootstrap import _DispatchAuth

    return _DispatchAuth(
        app_id="a",
        pem="PEM",
        installation_id=1,
        expires_at=datetime.now(timezone.utc) + remaining,
    )


def _urlopen_cm(status, content_length):
    """A fake urlopen() context manager for logfilter HEAD tests."""
    resp = MagicMock()
    resp.status = status
    resp.headers = (
        {} if content_length is None else {"Content-Length": str(content_length)}
    )
    cm = MagicMock()
    cm.__enter__.return_value = resp
    cm.__exit__.return_value = False
    return cm


class _DispatchHarness:
    """Patches the enumerator's output, ClickHouse, GitHub, and dispatch POST."""

    def __init__(
        self,
        reds,
        *,
        config=None,
        existing_rows=None,
        limit=None,
        dispatch_side_effect=None,
        log_ok=True,
    ):
        self.reds = reds
        self.config = config or make_config()
        self.existing_rows = existing_rows or []
        self.limit = (
            limit if limit is not None else self.config.effective_max_dispatches()
        )
        self.dispatch_side_effect = dispatch_side_effect
        self.sleep_calls = []
        self.log_calls = []

        def _log_check(job_id):
            self.log_calls.append(job_id)
            return log_ok(job_id) if callable(log_ok) else log_ok

        self.dispatcher = CoverageDispatcher(
            self.config,
            sleep=lambda s: self.sleep_calls.append(s),
            log_check=_log_check,
        )
        self.dispatcher._enumerator = MagicMock()
        self.dispatcher._enumerator.enumerate.return_value = reds

    def __enter__(self):
        self.mock_ch = MagicMock()
        qr = MagicMock()
        qr.result_rows = list(self.existing_rows)
        self.mock_ch.return_value.client.query.return_value = qr
        self.mock_ghf = MagicMock()
        self.dispatch_mock = MagicMock(side_effect=self.dispatch_side_effect)
        self._patchers = [
            patch("advisor_coverage.dispatcher.CHCliFactory", self.mock_ch),
            patch("advisor_coverage.dispatcher.GHClientFactory", self.mock_ghf),
            patch(
                "advisor_coverage.dispatcher.proper_workflow_create_dispatch",
                self.dispatch_mock,
            ),
        ]
        for p in self._patchers:
            p.start()
        self.dispatcher.begin_run(self.limit)
        return self

    def __exit__(self, *exc):
        for p in self._patchers:
            p.stop()
        return False


# ----------------------------------------------------------------------
# Payload — isolated-red schema matches the validated template
# ----------------------------------------------------------------------
class TestPayload(unittest.TestCase):
    TOP_KEYS = {
        "signal_key",
        "signal_source",
        "workflow_name",
        "job_base_name",
        "commit_order",
        "suspect_commit",
        "commits",
    }
    COMMIT_KEYS = {"sha", "timestamp", "partition", "is_suspect", "events"}
    EVENT_KEYS = {
        "status",
        "job_name",
        "job_id",
        "wf_run_id",
        "run_attempt",
        "started_at",
        "ended_at",
        "url",
        "log_url",
    }

    def test_schema_and_prefix_and_keying(self):
        red = make_red()
        payload = json.loads(build_isolated_red_payload(red, "pytorch/pytorch"))

        self.assertEqual(set(payload), self.TOP_KEYS)
        self.assertEqual(payload["signal_key"], "coverage_" + red.job_name)
        # signal_key is the NORMALIZED job key -- no shard index, no runner.
        self.assertEqual(payload["signal_key"], "coverage_linux-jammy / test (slow)")
        self.assertNotIn(", 2, 3", payload["signal_key"])
        self.assertNotIn("mt-l-runner-a", payload["signal_key"])
        self.assertEqual(payload["signal_source"], "job")
        self.assertEqual(payload["workflow_name"], "slow")
        self.assertEqual(payload["job_base_name"], red.job_base_name)
        self.assertEqual(payload["commit_order"], "newest_first")
        # keyed to the OBSERVED trunk commit
        self.assertEqual(payload["suspect_commit"], "sha_observed_1")

        commits = payload["commits"]
        self.assertEqual(len(commits), 1 + len(red.baselines))
        suspect_c = commits[0]
        self.assertEqual(set(suspect_c), self.COMMIT_KEYS)
        self.assertTrue(suspect_c["is_suspect"])
        self.assertIn("failed:", suspect_c["partition"])
        ev = suspect_c["events"][0]
        self.assertEqual(set(ev), self.EVENT_KEYS)
        self.assertEqual(ev["status"], "failure")
        self.assertEqual(ev["job_id"], red.suspect.job_id)
        self.assertEqual(
            ev["log_url"],
            f"https://ossci-raw-job-status.s3.amazonaws.com/log/{red.suspect.job_id}",
        )
        # the concrete event keeps the full shard+runner name (not normalized).
        self.assertEqual(ev["job_name"], red.suspect.name)
        self.assertEqual(
            ev["job_name"], "linux-jammy / test (slow, 2, 3, mt-l-runner-a)"
        )
        for bc in commits[1:]:
            self.assertFalse(bc["is_suspect"])
            self.assertIn("successful:", bc["partition"])
            self.assertEqual(bc["events"][0]["status"], "success")

    def test_coverage_signal_key(self):
        red = make_red(job_name="docker-build (x, y)")
        self.assertEqual(coverage_signal_key(red), "coverage_docker-build (x, y)")


# ----------------------------------------------------------------------
# Option A — coverage verdicts keyed at the NORMALIZED-job level
# ----------------------------------------------------------------------
class TestNormalizedKeying(unittest.TestCase):
    def test_signal_key_is_normalized_no_shard_or_runner(self):
        red = make_red(
            job_name="linux / test (slow)",
            run_name="linux / test (slow, 2, 3, mt-runner-a10g)",
        )
        self.assertEqual(coverage_signal_key(red), "coverage_linux / test (slow)")
        payload = json.loads(build_isolated_red_payload(red, "pytorch/pytorch"))
        self.assertEqual(payload["signal_key"], "coverage_linux / test (slow)")
        self.assertNotIn(", 2, 3", payload["signal_key"])
        self.assertNotIn("mt-runner-a10g", payload["signal_key"])
        self.assertEqual(payload["job_base_name"], "linux / test (slow)")

    def test_event_keeps_concrete_run_name_and_log(self):
        red = make_red(
            job_name="linux / test (slow)",
            run_name="linux / test (slow, 2, 3, mt-runner-a10g)",
            job_id=4242,
        )
        payload = json.loads(build_isolated_red_payload(red, "pytorch/pytorch"))
        ev = payload["commits"][0]["events"][0]
        self.assertEqual(ev["job_name"], "linux / test (slow, 2, 3, mt-runner-a10g)")
        self.assertEqual(
            ev["log_url"],
            "https://ossci-raw-job-status.s3.amazonaws.com/log/4242",
        )

    def test_dedup_key_uses_normalized_name(self):
        red = make_red(
            job_name="linux / test (slow)",
            run_name="linux / test (slow, 2, 3, mt-runner-a10g)",
        )
        # a verdict under the NORMALIZED key dedups the red...
        norm_existing = [(red.observed_commit, "coverage_linux / test (slow)")]
        with _DispatchHarness([red], existing_rows=norm_existing) as h:
            stats = h.dispatcher.dispatch_for_window(T(0), T(59))
        self.assertEqual(stats.skipped_existing, 1)
        self.assertEqual(stats.dispatched, 0)
        # ...but a verdict under the concrete shard+runner name does NOT.
        concrete_existing = [
            (red.observed_commit, "coverage_linux / test (slow, 2, 3, mt-runner-a10g)")
        ]
        with _DispatchHarness([red], existing_rows=concrete_existing) as h:
            stats = h.dispatcher.dispatch_for_window(T(0), T(59))
        self.assertEqual(stats.skipped_existing, 0)
        self.assertEqual(stats.would_dispatch, 1)

    def test_sibling_shards_same_commit_collapse_to_one_dispatch(self):
        # Post-SQL there is one red per normalized job; if the same normalized key +
        # observed commit surfaces more than once in a window, the intra-run dedup
        # collapses it to a single dispatch (no per-shard re-dispatch).
        reds = [
            make_red(
                job_name="linux / test (slow)",
                run_name=f"linux / test (slow, {i}, 3, runner-{i})",
                job_id=1000 + i,
            )
            for i in range(1, 4)
        ]
        with _DispatchHarness(reds) as h:
            stats = h.dispatcher.dispatch_for_window(T(0), T(59))
        self.assertEqual(stats.would_dispatch, 1)
        self.assertEqual(stats.skipped_duplicate, 2)

    def test_query_collapses_to_normalized_job(self):
        from advisor_coverage.sql import QUERY_BASELINES, QUERY_UNCLASSIFIED

        self.assertIn(
            "GROUP BY fj.head_sha, fj.workflow_name, fj.norm_name", QUERY_UNCLASSIFIED
        )
        self.assertIn("fj.norm_name AS norm_name", QUERY_UNCLASSIFIED)
        self.assertIn("{normNames:Array(String)}", QUERY_BASELINES)
        # advisor_agg strips a leading coverage_ so coverage verdicts attach here.
        self.assertIn("'^coverage_', ''", QUERY_UNCLASSIFIED)

    def test_representative_selection_tuple_has_job_id_tiebreaker(self):
        # The representative run per normalized job is picked with several
        # independent argMax(<col>, tuple) calls. Sibling shards share attempt=1
        # and often the same started_at second, so without a per-row-unique
        # tiebreaker different argMax calls can resolve to different shards and
        # tear the representative (job_id/log mismatching its name). job_id in the
        # ordering tuple makes the max unique so every argMax picks the same shard.
        from advisor_coverage.sql import QUERY_BASELINES, QUERY_UNCLASSIFIED

        self.assertIn("started_at_pick, rj.job_id", QUERY_UNCLASSIFIED)
        self.assertIn("started_at_pick, g.job_id", QUERY_BASELINES)

    def test_query_binds_by_commit_membership_not_created_at(self):
        from advisor_coverage.sql import QUERY_BASELINES, QUERY_UNCLASSIFIED

        for q in (QUERY_UNCLASSIFIED, QUERY_BASELINES):
            self.assertIn("materialized_views.workflow_job_by_head_sha", q)
            self.assertNotIn("j.created_at", q)


# ----------------------------------------------------------------------
# Prefix invariant + dispatch guard
# ----------------------------------------------------------------------
class TestPrefixInvariant(unittest.TestCase):
    def test_prefix_matches_torchci_literal(self):
        self.assertEqual(COVERAGE_SIGNAL_KEY_PREFIX, "coverage_")

    def test_prefix_not_configurable(self):
        self.assertFalse(hasattr(make_config(), "coverage_prefix"))
        cfg = CoverageConfig.from_env_and_event({"coverage_prefix": ""})
        self.assertFalse(hasattr(cfg, "coverage_prefix"))

    def test_dispatch_guard_never_posts_native_key(self):
        with _DispatchHarness([make_red()]) as h, patch(
            "advisor_coverage.dispatcher.COVERAGE_SIGNAL_KEY_PREFIX", ""
        ), patch("advisor_coverage.payload.COVERAGE_SIGNAL_KEY_PREFIX", ""):
            stats = h.dispatcher.dispatch_for_window(T(0), T(59))
        self.assertEqual(stats.dispatched, 0)
        self.assertEqual(stats.errors, 1)
        h.dispatch_mock.assert_not_called()


# ----------------------------------------------------------------------
# Dispatch: keying to observed commit, dry-run vs real, memoization
# ----------------------------------------------------------------------
class TestDispatch(unittest.TestCase):
    def test_dry_run_never_posts(self):
        with _DispatchHarness([make_red()], config=make_config(dry_run=True)) as h:
            stats = h.dispatcher.dispatch_for_window(T(0), T(59))
        self.assertEqual(stats.dispatched, 0)
        self.assertEqual(stats.would_dispatch, 1)
        h.dispatch_mock.assert_not_called()

    def test_real_run_keys_to_observed_commit_pr0(self):
        with _DispatchHarness([make_red()], config=make_config(dry_run=False)) as h:
            stats = h.dispatcher.dispatch_for_window(T(0), T(59))
        self.assertEqual(stats.dispatched, 1)
        kwargs = h.dispatch_mock.call_args.kwargs
        self.assertEqual(kwargs["ref"], "main")
        inputs = kwargs["inputs"]
        self.assertEqual(inputs["suspect_commit"], "sha_observed_1")
        self.assertEqual(inputs["pr_number"], "0")
        payload = json.loads(inputs["signal_pattern"])
        self.assertEqual(payload["signal_key"], "coverage_" + make_red().job_name)
        self.assertEqual(payload["suspect_commit"], "sha_observed_1")

    def test_workflow_handle_memoized(self):
        reds = [make_red(job_name=f"j{i} / test", observed=f"o{i}") for i in range(3)]
        with _DispatchHarness(reds, config=make_config(dry_run=False)) as h:
            h.dispatcher.dispatch_for_window(T(0), T(59))
        self.assertEqual(h.mock_ghf.return_value.client.get_repo.call_count, 1)


# ----------------------------------------------------------------------
# Log-readability pre-filter
# ----------------------------------------------------------------------
class TestLogFilter(unittest.TestCase):
    def test_stub_log_skipped(self):
        with _DispatchHarness([make_red()], log_ok=False) as h:
            stats = h.dispatcher.dispatch_for_window(T(0), T(59))
        self.assertEqual(stats.skipped_no_log, 1)
        self.assertEqual(stats.dispatched, 0)
        h.dispatch_mock.assert_not_called()

    def test_readable_log_dispatched(self):
        with _DispatchHarness([make_red()], log_ok=True) as h:
            stats = h.dispatcher.dispatch_for_window(T(0), T(59))
        self.assertEqual(stats.skipped_no_log, 0)
        self.assertEqual(stats.would_dispatch, 1)

    def test_has_readable_log_large_2xx(self):
        from advisor_coverage import logfilter

        with patch(
            "advisor_coverage.logfilter.urllib.request.urlopen",
            return_value=_urlopen_cm(200, 4096),
        ):
            self.assertTrue(logfilter.has_readable_log(123))

    def test_has_readable_log_stub_2xx_is_false(self):
        from advisor_coverage import logfilter

        with patch(
            "advisor_coverage.logfilter.urllib.request.urlopen",
            return_value=_urlopen_cm(200, 500),
        ):
            self.assertFalse(logfilter.has_readable_log(123))

    def test_has_readable_log_404_is_false(self):
        import urllib.error

        from advisor_coverage import logfilter

        err = urllib.error.HTTPError("u", 404, "Not Found", {}, None)
        with patch(
            "advisor_coverage.logfilter.urllib.request.urlopen", side_effect=err
        ):
            self.assertFalse(logfilter.has_readable_log(123))

    def test_has_readable_log_urlerror_is_false(self):
        import urllib.error

        from advisor_coverage import logfilter

        with patch(
            "advisor_coverage.logfilter.urllib.request.urlopen",
            side_effect=urllib.error.URLError("boom"),
        ):
            self.assertFalse(logfilter.has_readable_log(123))

    def test_has_readable_log_no_content_length_is_false(self):
        from advisor_coverage import logfilter

        with patch(
            "advisor_coverage.logfilter.urllib.request.urlopen",
            return_value=_urlopen_cm(200, None),
        ):
            self.assertFalse(logfilter.has_readable_log(123))


# ----------------------------------------------------------------------
# Windowless batch dedup + intra-run dedup
# ----------------------------------------------------------------------
class TestDedup(unittest.TestCase):
    def test_existing_verdict_skipped(self):
        red = make_red()
        existing = [(red.observed_commit, "coverage_" + red.job_name)]
        with _DispatchHarness([red], existing_rows=existing) as h:
            stats = h.dispatcher.dispatch_for_window(T(0), T(59))
        self.assertEqual(stats.skipped_existing, 1)
        self.assertEqual(stats.dispatched, 0)

    def test_dedup_query_is_one_windowless_batch(self):
        reds = [make_red(job_name=f"j{i} / t", observed=f"o{i}") for i in range(3)]
        with _DispatchHarness(reds) as h:
            h.dispatcher.dispatch_for_window(T(0), T(59))
        self.assertEqual(h.mock_ch.return_value.client.query.call_count, 1)
        query = h.mock_ch.return_value.client.query.call_args.args[0]
        params = h.mock_ch.return_value.client.query.call_args.kwargs["parameters"]
        self.assertIn("misc.autorevert_advisor_verdicts", query)
        self.assertIn("toString(suspect_commit)", query)
        self.assertIn("suspect_commit IN", query)
        self.assertIn("signal_key IN", query)
        self.assertNotIn("now()", query.lower())
        self.assertNotIn("interval", query.lower())
        self.assertEqual(len(params["keys"]), 3)

    def test_intra_run_duplicate_dispatched_once(self):
        red = make_red()  # commit_time T(30)
        with _DispatchHarness([red]) as h:
            s1 = h.dispatcher.dispatch_for_window(T(0), T(40))
            s2 = h.dispatcher.dispatch_for_window(T(20), T(59))  # overlapping
        self.assertEqual(s1.would_dispatch, 1)
        self.assertEqual(s2.would_dispatch, 0)
        self.assertEqual(s2.skipped_duplicate, 1)

    def test_emit_window_filters_out_of_range_reds(self):
        red_in = make_red(observed="in", job_name="a / t", minute=30)  # T(30)
        red_out = make_red(observed="out", job_name="b / t", minute=55)  # T(55)
        with _DispatchHarness([red_in, red_out]) as h:
            stats = h.dispatcher.dispatch_for_window(
                T(0), T(59), emit_start=T(20), emit_stop=T(40)
            )
        self.assertEqual(stats.eligible, 1)  # only red_in is in [T(20), T(40))
        self.assertEqual(stats.would_dispatch, 1)


# ----------------------------------------------------------------------
# Throttle: cap, gap, budget spanning, counters
# ----------------------------------------------------------------------
class TestThrottle(unittest.TestCase):
    def test_cap_and_gap(self):
        reds = [make_red(job_name=f"j{i} / t", observed=f"o{i}") for i in range(3)]
        with _DispatchHarness(reds, limit=2) as h:
            stats = h.dispatcher.dispatch_for_window(T(0), T(59))
        self.assertEqual(stats.would_dispatch, 2)
        self.assertTrue(stats.capped)
        self.assertEqual(h.sleep_calls, [3])

    def test_counters_count_successes_only(self):
        reds = [make_red(job_name=f"j{i} / t", observed=f"o{i}") for i in range(3)]
        with _DispatchHarness(
            reds,
            config=make_config(dry_run=False),
            dispatch_side_effect=[None, ValueError("boom"), None],
        ) as h:
            stats = h.dispatcher.dispatch_for_window(T(0), T(59))
        self.assertEqual(stats.dispatched, 2)
        self.assertEqual(stats.errors, 1)
        self.assertEqual(h.dispatcher.success_total, 2)
        self.assertEqual(h.dispatcher.attempts_total, 3)


# ----------------------------------------------------------------------
# Config: throttle caps, repo pin, workflows parse, event overrides
# ----------------------------------------------------------------------
class TestConfig(unittest.TestCase):
    def test_hard_cap(self):
        self.assertEqual(
            make_config(
                max_dispatches_per_run=10000, dispatch_gap_seconds=1
            ).effective_max_dispatches(),
            HARD_CAP_DISPATCHES,
        )

    def test_timeout_clamp(self):
        self.assertEqual(
            make_config(
                max_dispatches_per_run=10000, dispatch_gap_seconds=3
            ).effective_max_dispatches(),
            87,
        )

    def test_gap_floor(self):
        self.assertEqual(make_config(dispatch_gap_seconds=0).effective_gap_seconds(), 1)

    def test_backfill_gap_floor(self):
        cfg = make_config(mode="backfill", dispatch_gap_seconds=3)
        self.assertEqual(cfg.effective_gap_seconds(), BACKFILL_MIN_DISPATCH_GAP_SECONDS)
        raised = make_config(mode="backfill", dispatch_gap_seconds=60)
        self.assertEqual(raised.effective_gap_seconds(), 60)
        self.assertEqual(make_config(dispatch_gap_seconds=3).effective_gap_seconds(), 3)

    def test_repo_pin(self):
        with self.assertRaises(ValueError):
            CoverageConfig.from_env_and_event({"repo_full_name": "evil/repo"})

    def test_workflows_parse(self):
        self.assertEqual(_parse_workflows('["a","b"]'), ["a", "b"])
        self.assertEqual(_parse_workflows("a, b"), ["a", "b"])
        self.assertEqual(_parse_workflows(["x"]), ["x"])
        self.assertEqual(_parse_workflows(""), [])  # empty = all workflows

    def test_workflows_env_and_event(self):
        with patch.dict("os.environ", {"WORKFLOWS": '["pull"]'}, clear=False):
            self.assertEqual(CoverageConfig.from_env().workflows, ["pull"])
        self.assertEqual(
            CoverageConfig.from_env_and_event({"workflows": "trunk,slow"}).workflows,
            ["trunk", "slow"],
        )

    def test_lowercase_event_overrides(self):
        cfg = CoverageConfig.from_env_and_event(
            {
                "mode": "backfill",
                "hours": 48,
                "as_of_start": "2026-01-01",
                "as_of_end": "2026-01-05",
            }
        )
        self.assertEqual(cfg.mode, "backfill")
        self.assertEqual(cfg.hours, 48)
        self.assertIsNotNone(cfg.as_of_start)

    def test_uppercase_event_keys_ignored(self):
        cfg = CoverageConfig.from_env_and_event({"HOURS": 999})
        self.assertEqual(cfg.hours, config_mod.DEFAULT_HOURS)

    def test_dry_run_cannot_be_disabled_by_event(self):
        self.assertTrue(CoverageConfig.from_env_and_event({"dry_run": False}).dry_run)

    def test_min_runs_default_and_override(self):
        self.assertEqual(make_config().min_runs, config_mod.DEFAULT_MIN_RUNS)
        self.assertEqual(CoverageConfig.from_env_and_event({"min_runs": 5}).min_runs, 5)

    def test_backfill_requires_as_of_window(self):
        with self.assertRaises(ValueError):
            CoverageConfig.from_env_and_event({"mode": "backfill"})

    def test_backfill_as_of_must_be_ordered(self):
        with self.assertRaises(ValueError):
            CoverageConfig.from_env_and_event(
                {
                    "mode": "backfill",
                    "as_of_start": "2026-01-05",
                    "as_of_end": "2026-01-01",
                }
            )


# ----------------------------------------------------------------------
# Enumeration assembly (mocked CH)
# ----------------------------------------------------------------------
class TestEnumeration(unittest.TestCase):
    def _result(self, columns, rows):
        r = MagicMock()
        r.column_names = columns
        r.result_rows = rows
        return r

    def test_assembles_red_with_baselines_before(self):
        unc_cols = [
            "head_sha",
            "commit_time",
            "workflow_name",
            "name",
            "norm_name",
            "job_id",
            "run_id",
            "run_attempt",
            "started_at",
            "completed_at",
        ]
        unc_rows = [
            (
                "sha_obs",
                T(30),
                "slow",
                "linux / test (slow, 2, 3, runner-a)",
                "linux / test (slow)",
                900,
                901,
                1,
                T(30),
                T(40),
            ),
        ]
        base_cols = [
            "workflow_name",
            "norm_name",
            "head_sha",
            "commit_time",
            "name",
            "job_id",
            "run_id",
            "run_attempt",
            "started_at",
            "completed_at",
        ]
        base_rows = [
            (
                "slow",
                "linux / test (slow)",
                "sha_future",
                T(50),
                "linux / test (slow, 2, 3, runner-a)",
                700,
                701,
                1,
                T(50),
                T(55),
            ),
            (
                "slow",
                "linux / test (slow)",
                "sha_before",
                T(20),
                "linux / test (slow, 2, 3, runner-a)",
                800,
                801,
                1,
                T(20),
                T(25),
            ),
        ]
        mock_ch = MagicMock()
        mock_ch.return_value.client.query.side_effect = [
            self._result(unc_cols, unc_rows),
            self._result(base_cols, base_rows),
        ]
        with patch("advisor_coverage.enumeration.CHCliFactory", mock_ch):
            reds = UnclassifiedRedEnumerator(make_config()).enumerate(T(0), T(59))

        self.assertEqual(len(reds), 1)
        red = reds[0]
        self.assertEqual(red.observed_commit, "sha_obs")
        self.assertEqual(red.job_name, "linux / test (slow)")
        self.assertEqual(red.job_base_name, "linux / test (slow)")
        self.assertEqual(red.suspect.name, "linux / test (slow, 2, 3, runner-a)")
        self.assertEqual(red.suspect.job_id, 900)
        # only the baseline BEFORE the suspect's commit_time is kept
        self.assertEqual([b.sha for b in red.baselines], ["sha_before"])
        # the unclassified query is parameterized with minRuns (M1)
        first_call = mock_ch.return_value.client.query.call_args_list[0]
        self.assertEqual(first_call.kwargs["parameters"]["minRuns"], 20)

    def test_query_has_minruns_and_jobcounts_filter(self):
        from advisor_coverage.sql import QUERY_UNCLASSIFIED

        self.assertIn("job_counts", QUERY_UNCLASSIFIED)
        self.assertIn("{minRuns:Int32}", QUERY_UNCLASSIFIED)
        self.assertIn("total_runs >= {minRuns:Int32}", QUERY_UNCLASSIFIED)

    def test_empty_enumeration_skips_baseline_query(self):
        mock_ch = MagicMock()
        mock_ch.return_value.client.query.return_value = self._result([], [])
        with patch("advisor_coverage.enumeration.CHCliFactory", mock_ch):
            reds = UnclassifiedRedEnumerator(make_config()).enumerate(T(0), T(59))
        self.assertEqual(reds, [])
        self.assertEqual(mock_ch.return_value.client.query.call_count, 1)

    def test_workflow_filter_applied_only_when_set(self):
        enum_all = UnclassifiedRedEnumerator(make_config(workflows=[]))
        enum_wf = UnclassifiedRedEnumerator(make_config(workflows=["slow"]))
        from advisor_coverage.sql import QUERY_UNCLASSIFIED

        self.assertNotIn(
            "workflow_name IN", enum_all._apply_workflow_filter(QUERY_UNCLASSIFIED)
        )
        self.assertIn(
            "workflow_name IN", enum_wf._apply_workflow_filter(QUERY_UNCLASSIFIED)
        )


# ----------------------------------------------------------------------
# Backfill: time-window chunks + resume cursor
# ----------------------------------------------------------------------
class TestBackfill(unittest.TestCase):
    def _cfg(self):
        return make_config(
            mode="backfill",
            as_of_start=datetime(2026, 1, 1, 0, 0),
            as_of_end=datetime(2026, 1, 2, 0, 0),
            as_of_step_hours=6,
        )  # chunks: 00,06,12,18 -> 4

    CURSOR0 = "2026-01-01 00:00:00"  # naive strftime of as_of_start

    def _dispatcher(self, reds=None):
        d = CoverageDispatcher(
            make_config(), sleep=lambda s: None, log_check=lambda j: True
        )
        d._enumerator = MagicMock()
        d._enumerator.enumerate.return_value = reds or []
        return d

    def test_completes_to_end(self):
        cfg = self._cfg()
        result = run_backfill(cfg, self._dispatcher(), deadline=None, limit=None)
        self.assertEqual(result["chunks_run"], 4)
        self.assertIsNone(result["next_as_of"])
        self.assertEqual(result["stop_reason"], "complete")

    def test_deadline_returns_naive_cursor(self):
        cfg = self._cfg()
        result = run_backfill(
            cfg, self._dispatcher(), deadline=time.monotonic() - 1, limit=None
        )
        self.assertEqual(result["chunks_run"], 0)
        self.assertEqual(result["stop_reason"], "deadline")
        self.assertEqual(result["next_as_of"], self.CURSOR0)

    def test_budget_returns_naive_cursor(self):
        cfg = self._cfg()
        result = run_backfill(cfg, self._dispatcher(), deadline=None, limit=0)
        self.assertEqual(result["stop_reason"], "budget")
        self.assertEqual(result["next_as_of"], self.CURSOR0)

    def test_per_chunk_error_returns_cursor(self):
        cfg = self._cfg()
        d = self._dispatcher()
        d._enumerator.enumerate.side_effect = RuntimeError("CH down")
        result = run_backfill(cfg, d, deadline=None, limit=None)
        self.assertEqual(result["stop_reason"], "error")
        self.assertEqual(result["next_as_of"], self.CURSOR0)

    def test_capped_midchunk_resumes_inside_chunk_no_loss(self):
        # C3: 3 reds in chunk0 [00:00, 06:00), budget=2 → dispatch 2, cap,
        # resume at chunk0 start (NOT chunk_stop) so the 3rd red isn't lost.
        cfg = self._cfg()
        reds = [
            make_red(
                observed=f"o{i}",
                job_name=f"j{i} / t",
                commit_dt=datetime(2026, 1, 1, 1 + i, 0),  # 01:00, 02:00, 03:00
            )
            for i in range(3)
        ]
        d = self._dispatcher(reds)
        mock_ch = MagicMock()
        mock_ch.return_value.client.query.return_value.result_rows = []
        with patch("advisor_coverage.dispatcher.CHCliFactory", mock_ch):
            result = run_backfill(cfg, d, deadline=None, limit=2)
        self.assertEqual(result["stop_reason"], "capped")
        self.assertEqual(result["chunks_run"], 1)
        self.assertEqual(result["dispatched"], 0)
        self.assertEqual(result["would_dispatch"], 2)
        self.assertEqual(result["next_as_of"], self.CURSOR0)  # did NOT advance

    def test_cursor_roundtrips_through_parse_datetime(self):
        # C4: the emitted cursor must be parseable by the vendored parse_datetime.
        cfg = self._cfg()
        result = run_backfill(cfg, self._dispatcher(), deadline=None, limit=0)
        cursor = result["next_as_of"]
        parsed = CoverageConfig.from_env_and_event(
            {"mode": "backfill", "as_of_start": cursor, "as_of_end": "2026-01-02"}
        )
        self.assertEqual(parsed.as_of_start.strftime("%Y-%m-%d %H:%M:%S"), cursor)


# ----------------------------------------------------------------------
# S1 / S2 — logging pins secret loggers; token mint is scoped
# ----------------------------------------------------------------------
class TestBootstrapSecurity(unittest.TestCase):
    def test_configure_logging_pins_secret_loggers(self):
        from advisor_coverage.bootstrap import configure_logging

        configure_logging("DEBUG")
        for name in ("github", "github.Requester", "botocore", "boto3", "urllib3"):
            self.assertEqual(logging.getLogger(name).level, logging.WARNING, name)

    # Patches only GithubIntegration, so the surrounding call path runs against
    # real PyGithub: a mint that cannot produce a token without a Requester
    # fails here instead of passing against an all-mocked github module.
    @patch("advisor_coverage.bootstrap.github.GithubIntegration")
    def test_mint_scopes_token_to_actions_write(self, mock_integration):
        import github

        from advisor_coverage.bootstrap import _mint_scoped_installation_auth

        get_token = mock_integration.return_value.get_access_token
        get_token.return_value.token = "ghs_scoped"
        scoped = _mint_scoped_installation_auth("app-id", "PEM", 4242)
        self.assertEqual(scoped.token, "ghs_scoped")
        self.assertIsInstance(
            mock_integration.call_args.kwargs["auth"], github.Auth.AppAuth
        )
        args, kwargs = get_token.call_args
        self.assertEqual(args, (4242,))
        self.assertEqual(kwargs["permissions"], {"actions": "write"})

    @patch("advisor_coverage.bootstrap.github.GithubIntegration")
    def test_mint_failure_names_the_identifiers(self, mock_integration):
        import github

        from advisor_coverage.bootstrap import _mint_scoped_installation_auth

        mock_integration.return_value.get_access_token.side_effect = (
            github.GithubException(401, {"message": "could not be decoded"}, None)
        )
        with self.assertRaises(RuntimeError) as ctx:
            _mint_scoped_installation_auth("app-id", "PEM", 4242)
        self.assertIn("app-id", str(ctx.exception))
        self.assertIn("4242", str(ctx.exception))

    def test_token_refresh_noop_without_app_auth(self):
        from advisor_coverage import bootstrap

        bootstrap._dispatch_auth = None
        self.assertFalse(bootstrap.refresh_dispatch_token_if_stale())

    def test_token_refresh_noop_while_fresh(self):
        from advisor_coverage import bootstrap

        bootstrap._dispatch_auth = _auth_expiring_in(timedelta(minutes=59))
        try:
            with patch(
                "advisor_coverage.bootstrap._mint_scoped_installation_auth"
            ) as mint:
                self.assertFalse(bootstrap.refresh_dispatch_token_if_stale())
            mint.assert_not_called()
        finally:
            bootstrap._dispatch_auth = None

    def test_token_reminted_inside_the_expiry_margin(self):
        from advisor_coverage import bootstrap

        # Still valid, but inside the margin — a dispatch now could outlive it.
        bootstrap._dispatch_auth = _auth_expiring_in(timedelta(minutes=5))
        try:
            with patch(
                "advisor_coverage.bootstrap._mint_scoped_installation_auth",
                return_value=_minted("ghs_new", timedelta(minutes=60)),
            ) as mint, patch("advisor_coverage.bootstrap.GHClientFactory") as ghf:
                self.assertTrue(bootstrap.refresh_dispatch_token_if_stale())
                mint.assert_called_once_with("a", "PEM", 1)
                ghf.setup_client.assert_called_once_with(token="ghs_new")
                # Expiry advanced, so the next dispatch does not re-mint again.
                self.assertFalse(bootstrap.refresh_dispatch_token_if_stale())
        finally:
            bootstrap._dispatch_auth = None

    def test_token_reminted_after_a_suspend(self):
        """An already-expired token re-mints even with no elapsed process time."""
        from advisor_coverage import bootstrap

        bootstrap._dispatch_auth = _auth_expiring_in(timedelta(minutes=-30))
        try:
            with patch(
                "advisor_coverage.bootstrap._mint_scoped_installation_auth",
                return_value=_minted("ghs_new", timedelta(minutes=60)),
            ), patch("advisor_coverage.bootstrap.GHClientFactory"):
                self.assertTrue(bootstrap.refresh_dispatch_token_if_stale())
        finally:
            bootstrap._dispatch_auth = None

    def test_dispatch_checks_token_freshness(self):
        reds = [make_red(job_name="j / t", observed="o1")]
        with patch(
            "advisor_coverage.dispatcher.refresh_dispatch_token_if_stale"
        ) as refresh:
            with _DispatchHarness(reds, config=make_config(dry_run=False)) as h:
                h.dispatcher.dispatch_for_window(T(0), T(59))
        refresh.assert_called_once_with()

    def test_setup_clients_uses_scoped_token(self):
        cfg = make_config(
            github_app_id="app-id",
            github_installation_id=4242,
            github_app_secret=base64.b64encode(b"PEM").decode(),
        )
        with patch(
            "advisor_coverage.bootstrap._mint_scoped_installation_auth",
            return_value=_minted("ghs_scoped", timedelta(minutes=60)),
        ) as mint, patch("advisor_coverage.bootstrap.GHClientFactory") as ghf, patch(
            "advisor_coverage.bootstrap.CHCliFactory"
        ) as ch:
            ch.return_value.connection_test.return_value = True
            from advisor_coverage.bootstrap import setup_clients

            setup_clients(cfg)
        mint.assert_called_once_with("app-id", "PEM", 4242)
        ghf.setup_client.assert_called_once_with(token="ghs_scoped")


if __name__ == "__main__":
    unittest.main()
