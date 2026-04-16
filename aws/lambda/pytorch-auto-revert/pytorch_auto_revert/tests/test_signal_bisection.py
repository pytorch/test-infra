import unittest
from datetime import datetime, timedelta

from pytorch_auto_revert.signal import Signal, SignalCommit, SignalEvent, SignalStatus


def ts(base: datetime, minutes: int) -> datetime:
    return base + timedelta(minutes=minutes)


def ev(name: str, status: SignalStatus, t0: datetime, minute: int) -> SignalEvent:
    return SignalEvent(name=name, status=status, started_at=ts(t0, minute), wf_run_id=1)


def build_gap_signal(unknown_k: int, *, pending_idx: set[int] | None = None):
    pending_idx = pending_idx or set()
    t0 = datetime(2025, 8, 19, 12, 0, 0)

    # Failure side (3 failures to avoid extra side restarts interfering)
    c_fail_newest = SignalCommit(
        head_sha="sha_fail_newest",
        timestamp=ts(t0, 0),
        events=[ev("job", SignalStatus.FAILURE, t0, 10)],
    )
    c_fail_mid = SignalCommit(
        head_sha="sha_fail_mid",
        timestamp=ts(t0, 0),
        events=[ev("job", SignalStatus.FAILURE, t0, 9)],
    )
    c_fail_old = SignalCommit(
        head_sha="sha_fail_old",
        timestamp=ts(t0, 0),
        events=[ev("job", SignalStatus.FAILURE, t0, 8)],
    )

    unknown_commits = []
    unknown_shas = []
    for i in range(unknown_k):
        sha = f"sha_unknown_{i}"
        unknown_shas.append(sha)
        if i in pending_idx:
            events = [ev("job", SignalStatus.PENDING, t0, 7 - i)]
        else:
            events = []
        unknown_commits.append(
            SignalCommit(head_sha=sha, timestamp=ts(t0, 0), events=events)
        )

    c_success_base = SignalCommit(
        head_sha="sha_success_base",
        timestamp=ts(t0, 0),
        events=[ev("job", SignalStatus.SUCCESS, t0, 1)],
    )

    commits = (
        [c_fail_newest, c_fail_mid, c_fail_old] + unknown_commits + [c_success_base]
    )
    s = Signal(key="job", workflow_name="wf", commits=commits)
    return s, unknown_shas


class TestSignalBisection(unittest.TestCase):
    def test_unlimited_schedules_all_missing(self):
        s, unknown_shas = build_gap_signal(unknown_k=4)
        res = s.process_valid_autorevert_pattern(bisection_limit=None)
        self.assertTrue(hasattr(res, "commit_shas"))
        for sha in unknown_shas:
            self.assertIn(sha, res.commit_shas)

    def test_limit_one_picks_middle(self):
        s, unknown_shas = build_gap_signal(unknown_k=4)
        res = s.process_valid_autorevert_pattern(bisection_limit=1)
        self.assertTrue(hasattr(res, "commit_shas"))
        self.assertIn(unknown_shas[1], res.commit_shas)

    def test_limit_two_picks_two_middles(self):
        s, unknown_shas = build_gap_signal(unknown_k=4)
        res = s.process_valid_autorevert_pattern(bisection_limit=2)
        self.assertTrue(hasattr(res, "commit_shas"))
        self.assertIn(unknown_shas[1], res.commit_shas)
        self.assertIn(unknown_shas[2], res.commit_shas)

    def test_split_by_pending_reduces_budget(self):
        s, unknown_shas = build_gap_signal(unknown_k=4, pending_idx={1})
        res = s.process_valid_autorevert_pattern(bisection_limit=1)
        self.assertTrue(hasattr(res, "commit_shas"))
        # Budget fully consumed by existing pending → no new unknown scheduled
        for sha in unknown_shas:
            self.assertNotIn(sha, res.commit_shas)

    def test_no_budget_due_to_existing_pending(self):
        s, _ = build_gap_signal(unknown_k=2, pending_idx={0})
        res = s.process_valid_autorevert_pattern(bisection_limit=1)
        if hasattr(res, "commit_shas"):
            for sha in res.commit_shas:
                self.assertNotIn("sha_unknown_", sha)

    def test_odd_length_mid_floor(self):
        s, unknown_shas = build_gap_signal(unknown_k=3)
        res = s.process_valid_autorevert_pattern(bisection_limit=1)
        self.assertTrue(hasattr(res, "commit_shas"))
        self.assertIn(unknown_shas[1], res.commit_shas)

    def test_tie_between_two_gaps(self):
        s, unknown_shas = build_gap_signal(unknown_k=5, pending_idx={2})
        res = s.process_valid_autorevert_pattern(bisection_limit=2)
        self.assertTrue(hasattr(res, "commit_shas"))
        self.assertTrue(
            (unknown_shas[0] in res.commit_shas) or (unknown_shas[3] in res.commit_shas)
        )


if __name__ == "__main__":
    unittest.main()
