import json
import unittest
from datetime import datetime, timedelta
from unittest.mock import patch

from pytorch_auto_revert.run_state_logger import RunStateLogger
from pytorch_auto_revert.signal import (
    AutorevertPattern,
    Ineligible,
    IneligibleReason,
    RestartCommits,
    Signal,
    SignalCommit,
    SignalEvent,
    SignalStatus,
)
from pytorch_auto_revert.signal_extraction_types import RunContext
from pytorch_auto_revert.utils import RestartAction, RevertAction


def ts(base: datetime, minutes: int) -> datetime:
    return base + timedelta(minutes=minutes)


class TestRunStateLogger(unittest.TestCase):
    def setUp(self) -> None:
        self.t0 = datetime(2025, 9, 22, 18, 59, 14)

    def _ev(
        self,
        name: str,
        status: SignalStatus,
        minute: int,
        *,
        wf_run_id: int = 1,
        job_id: int | None = None,
        run_attempt: int | None = None,
    ) -> SignalEvent:
        return SignalEvent(
            name=name,
            status=status,
            started_at=ts(self.t0, minute),
            wf_run_id=wf_run_id,
            job_id=job_id,
            run_attempt=run_attempt,
        )

    def _ctx(self, *, restart: RestartAction, revert: RevertAction) -> RunContext:
        return RunContext(
            lookback_hours=8,
            notify_issue_number=123,
            repo_full_name="owner/repo",
            restart_action=restart,
            revert_action=revert,
            ts=self.t0,
            workflows=["wf-a", "wf-b"],
        )

    @patch("pytorch_auto_revert.run_state_logger.CHCliFactory")
    def test_build_and_insert_state_mixed_outcomes_calls_clickhouse_correctly(
        self, mock_factory
    ) -> None:
        # Build three signals with events across commits
        # Revert-signal (job level)
        c1 = SignalCommit(
            head_sha="sha_new",
            timestamp=ts(self.t0, 12),
            events=[
                self._ev("job-a", SignalStatus.FAILURE, 12, wf_run_id=111, job_id=999)
            ],
        )
        c2 = SignalCommit(
            head_sha="sha_old",
            timestamp=ts(self.t0, 5),
            events=[self._ev("job-a", SignalStatus.SUCCESS, 5)],
        )
        sig_revert = Signal(
            key="job-a",
            workflow_name="wf-a",
            commits=[c1, c2],
            job_base_name="job-a-base",
        )
        outcome_revert = AutorevertPattern(
            workflow_name="wf-a",
            newer_failing_commits=["sha_new"],
            suspected_commit="sha_old",
            older_successful_commit="sha_old",
            wf_run_id=111,
            job_id=999,
        )

        # Restart-signal (e.g., uncertainty)
        r1 = SignalCommit(
            head_sha="R_sha1",
            timestamp=ts(self.t0, 20),
            events=[self._ev("job-b", SignalStatus.PENDING, 20)],
        )
        r2 = SignalCommit(
            head_sha="R_sha0",
            timestamp=ts(self.t0, 10),
            events=[self._ev("job-b", SignalStatus.SUCCESS, 10)],
        )
        sig_restart = Signal(
            key="job-b",
            workflow_name="wf-b",
            commits=[r1, r2],
        )
        outcome_restart = RestartCommits(commit_shas={"R_sha0"})

        # Ineligible-signal (e.g., flaky)
        i1 = SignalCommit(
            head_sha="I_sha1",
            timestamp=ts(self.t0, 30),
            events=[self._ev("job-c", SignalStatus.SUCCESS, 30)],
        )
        i2 = SignalCommit(
            head_sha="I_sha0",
            timestamp=ts(self.t0, 15),
            events=[self._ev("job-c", SignalStatus.FAILURE, 15)],
        )
        sig_ineligible = Signal(
            key="job-c",
            workflow_name="wf-c",
            commits=[i1, i2],
        )
        outcome_ineligible = Ineligible(IneligibleReason.FLAKY, "flaky")

        pairs = [
            (sig_revert, outcome_revert),
            (sig_restart, outcome_restart),
            (sig_ineligible, outcome_ineligible),
        ]

        ctx = self._ctx(restart=RestartAction.LOG, revert=RevertAction.RUN_LOG)

        rsl = RunStateLogger()
        state_json = rsl.insert_state(ctx=ctx, pairs=pairs, params="k=v")

        # Verify ClickHouse insert was called once with expected arguments
        self.assertTrue(mock_factory.return_value.client.insert.called)
        args, kwargs = mock_factory.return_value.client.insert.call_args
        self.assertEqual(kwargs.get("table"), "autorevert_state")
        self.assertEqual(kwargs.get("database"), "misc")
        self.assertEqual(
            kwargs.get("column_names"),
            [
                "ts",
                "repo",
                "state",
                "dry_run",
                "workflows",
                "lookback_hours",
                "params",
            ],
        )
        # One row inserted
        data = kwargs.get("data")
        self.assertIsInstance(data, list)
        self.assertEqual(len(data), 1)
        row = data[0]
        # dry_run should be 0 because revert_action has side effects (RUN_LOG)
        self.assertEqual(row[3], 0)
        self.assertEqual(row[4], ctx.workflows)
        self.assertEqual(row[5], ctx.lookback_hours)
        self.assertEqual(row[6], "k=v")

        # Validate state JSON contents
        state = json.loads(state_json)
        # Outcomes include all three signal types
        outcomes = state.get("outcomes", {})
        self.assertIn("wf-a:job-a", outcomes)
        self.assertIn("wf-b:job-b", outcomes)
        self.assertIn("wf-c:job-c", outcomes)
        self.assertEqual(outcomes["wf-a:job-a"]["type"], "AutorevertPattern")
        self.assertEqual(outcomes["wf-b:job-b"]["type"], "RestartCommits")
        self.assertEqual(outcomes["wf-c:job-c"]["type"], "Ineligible")

        # Columns reflect per-signal outcomes
        cols = state.get("columns", [])
        self.assertEqual(len(cols), 3)
        # Find revert column
        col_revert = next(c for c in cols if c["outcome"] == "revert")
        self.assertEqual(col_revert["workflow"], "wf-a")
        self.assertEqual(col_revert["key"], "job-a")
        # Cells include entries for commits we provided
        self.assertIn("sha_new", col_revert["cells"])  # failure event on newest commit
        self.assertIn("sha_old", col_revert["cells"])  # success event on older commit

    @patch("pytorch_auto_revert.run_state_logger.CHCliFactory")
    def test_insert_state_sets_dry_run_based_on_actions(self, mock_factory) -> None:
        # No side effects → dry_run=1
        c = SignalCommit(
            head_sha="S",
            timestamp=ts(self.t0, 0),
            events=[self._ev("job", SignalStatus.PENDING, 0)],
        )
        sig = Signal(key="job", workflow_name="wf", commits=[c])
        pairs = [(sig, Ineligible(IneligibleReason.NO_SUCCESSES, ""))]

        ctx_dry = self._ctx(restart=RestartAction.LOG, revert=RevertAction.LOG)
        rsl = RunStateLogger()
        rsl.insert_state(ctx=ctx_dry, pairs=pairs)
        _, kwargs1 = mock_factory.return_value.client.insert.call_args
        row1 = kwargs1["data"][0]
        self.assertEqual(row1[3], 1)  # dry_run=1

        # With side effects → dry_run=0
        ctx_wet = self._ctx(restart=RestartAction.RUN, revert=RevertAction.SKIP)
        rsl.insert_state(ctx=ctx_wet, pairs=pairs)
        _, kwargs2 = mock_factory.return_value.client.insert.call_args
        row2 = kwargs2["data"][0]
        self.assertEqual(row2[3], 0)  # dry_run=0


if __name__ == "__main__":
    unittest.main()
