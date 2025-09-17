import unittest
from datetime import datetime, timedelta, timezone

from pytorch_auto_revert.signal_actions import SignalActionProcessor, SignalMetadata
from pytorch_auto_revert.signal_extraction_types import RunContext


class FakeLogger:
    def __init__(self):
        self._recent = []
        self.insert_calls = []

    def prior_revert_exists(self, *, repo: str, commit_sha: str) -> bool:
        return False

    def recent_restarts(
        self, *, repo: str, workflow: str, commit_sha: str, limit: int = 2
    ):
        return list(self._recent)

    def insert_event(
        self,
        *,
        repo: str,
        ts: datetime,
        action: str,
        commit_sha: str,
        workflows: list[str],
        source_signal_keys: list[str],
        dry_run: bool,
        failed: bool,
        notes: str = "",
    ) -> None:
        self.insert_calls.append(
            (
                repo,
                ts,
                action,
                commit_sha,
                tuple(workflows),
                tuple(source_signal_keys),
                dry_run,
                failed,
                notes,
            )
        )


class FakeRestart:
    def restart_workflow(self, workflow_name: str, commit_sha: str) -> bool:
        return True


class TestSignalActionsPacing(unittest.TestCase):
    def setUp(self) -> None:
        self.proc = SignalActionProcessor()
        # Inject fakes
        self.fake_logger = FakeLogger()
        self.proc._logger = self.fake_logger  # type: ignore[attr-defined]
        self.proc._restart = FakeRestart()  # type: ignore[attr-defined]
        self.ctx = RunContext(
            ts=datetime.now(timezone.utc),
            repo_full_name="pytorch/pytorch",
            workflows=["trunk"],
            lookback_hours=24,
            dry_run=True,  # ensures no GH calls are made
        )

    def test_skip_cap_when_two_recent(self):
        self.fake_logger._recent = [
            self.ctx.ts - timedelta(minutes=1),
            self.ctx.ts - timedelta(minutes=2),
        ]
        ok = self.proc.execute_restart(
            workflow_target="trunk",
            commit_sha="deadbeef",
            sources=[SignalMetadata(workflow_name="trunk", key="k")],
            ctx=self.ctx,
        )
        self.assertFalse(ok)
        self.assertEqual(len(self.fake_logger.insert_calls), 0)

    def test_skip_pacing_when_within_15min(self):
        self.fake_logger._recent = [self.ctx.ts - timedelta(minutes=5)]
        ok = self.proc.execute_restart(
            workflow_target="trunk",
            commit_sha="deadbeef",
            sources=[SignalMetadata(workflow_name="trunk", key="k")],
            ctx=self.ctx,
        )
        self.assertFalse(ok)
        self.assertEqual(len(self.fake_logger.insert_calls), 0)

    def test_allow_when_outside_pacing(self):
        self.fake_logger._recent = [self.ctx.ts - timedelta(minutes=20)]
        ok = self.proc.execute_restart(
            workflow_target="trunk",
            commit_sha="deadbeef",
            sources=[SignalMetadata(workflow_name="trunk", key="k")],
            ctx=self.ctx,
        )
        self.assertTrue(ok)
        self.assertEqual(len(self.fake_logger.insert_calls), 1)


if __name__ == "__main__":
    unittest.main()
