import unittest
from datetime import datetime, timedelta

from pytorch_auto_revert.signal import Signal, SignalCommit, SignalEvent, SignalStatus
from pytorch_auto_revert.signal_extraction import SignalExtractor


def ts(base: datetime, minutes: int) -> datetime:
    return base + timedelta(minutes=minutes)


class TestSignalDedup(unittest.TestCase):
    def setUp(self) -> None:
        self.t0 = datetime(2025, 8, 20, 12, 0, 0)

    def test_dedup_keeps_both_statuses(self):
        # Two events with identical (started_at, wf_run_id) but different statuses
        # should both be retained after dedup (we dedup by (started_at, wf_run_id, status)).
        e1 = SignalEvent(
            name="job-a",
            status=SignalStatus.FAILURE,
            started_at=ts(self.t0, 1),
            wf_run_id=100,
        )
        e2 = SignalEvent(
            name="job-b",
            status=SignalStatus.SUCCESS,
            started_at=ts(self.t0, 1),
            wf_run_id=100,
        )
        commit = SignalCommit(head_sha="sha", timestamp=ts(self.t0, 0), events=[e1, e2])
        s = Signal(key="k", workflow_name="wf", commits=[commit])

        ex = SignalExtractor(workflows=["wf"], lookback_hours=24)
        out = ex._dedup_signal_events([s])
        self.assertEqual(len(out), 1)
        # Both events survive because status differs
        self.assertEqual(len(out[0].commits[0].events), 2)
        statuses = {e.status for e in out[0].commits[0].events}
        self.assertEqual(statuses, {SignalStatus.FAILURE, SignalStatus.SUCCESS})

    def test_dedup_keeps_non_duplicates(self):
        e1 = SignalEvent(
            name="job-a",
            status=SignalStatus.FAILURE,
            started_at=ts(self.t0, 1),
            wf_run_id=1,
        )
        e2 = SignalEvent(
            name="job-b",
            status=SignalStatus.SUCCESS,
            started_at=ts(self.t0, 1),
            wf_run_id=2,
        )
        e3 = SignalEvent(
            name="job-c",
            status=SignalStatus.PENDING,
            started_at=ts(self.t0, 2),
            wf_run_id=1,
        )
        commit = SignalCommit(
            head_sha="sha", timestamp=ts(self.t0, 0), events=[e1, e2, e3]
        )
        s = Signal(key="k", workflow_name="wf", commits=[commit])

        ex = SignalExtractor(workflows=["wf"], lookback_hours=24)
        out = ex._dedup_signal_events([s])
        self.assertEqual(len(out[0].commits[0].events), 3)

    def test_dedup_applies_per_commit(self):
        # Dedup applies per commit: each commit retains at most one event per status
        e1 = SignalEvent(
            name="job-a",
            status=SignalStatus.FAILURE,
            started_at=ts(self.t0, 1),
            wf_run_id=100,
        )
        e2 = SignalEvent(
            name="job-b",
            status=SignalStatus.SUCCESS,
            started_at=ts(self.t0, 1),
            wf_run_id=100,
        )
        c1 = SignalCommit(head_sha="sha1", timestamp=ts(self.t0, 0), events=[e1, e2])
        c2 = SignalCommit(head_sha="sha2", timestamp=ts(self.t0, 0), events=[e1, e2])
        s = Signal(key="k", workflow_name="wf", commits=[c1, c2])

        ex = SignalExtractor(workflows=["wf"], lookback_hours=24)
        out = ex._dedup_signal_events([s])
        # Both commits should each have two events (one per status) after dedup
        self.assertEqual([len(c.events) for c in out[0].commits], [2, 2])


if __name__ == "__main__":
    unittest.main()
