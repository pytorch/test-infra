import unittest
from datetime import datetime, timedelta

from pytorch_auto_revert.signal import (
    AutorevertPattern,
    Ineligible,
    IneligibleReason,
    InfraCheckResult,
    PartitionedCommits,
    Signal,
    SignalCommit,
    SignalEvent,
    SignalStatus,
)


def ts(base: datetime, minutes: int) -> datetime:
    return base + timedelta(minutes=minutes)


class TestSignal(unittest.TestCase):
    def setUp(self) -> None:
        self.t0 = datetime(2025, 8, 19, 12, 0, 0)

    def _ev(self, name: str, status: SignalStatus, minute: int) -> SignalEvent:
        return SignalEvent(
            name=name,
            status=status,
            started_at=ts(self.t0, minute),
            wf_run_id=1,
        )

    def test_detect_recovered_first_non_pending_success(self):
        # Newest commit has success (even with pending present) -> recovered
        c_new = SignalCommit(
            head_sha="new",
            events=[
                self._ev("job", SignalStatus.PENDING, 1),
                self._ev("job", SignalStatus.SUCCESS, 2),
            ],
        )
        c_old = SignalCommit(
            head_sha="old",
            events=[self._ev("job", SignalStatus.FAILURE, 1)],
        )
        s = Signal(key="job", workflow_name="wf", commits=[c_new, c_old])
        self.assertTrue(s.detect_fixed())

    def test_detect_recovered_false_when_first_non_pending_failure(self):
        # Newest commit only has failure (no success)
        c_new = SignalCommit(
            head_sha="new",
            events=[self._ev("job", SignalStatus.FAILURE, 1)],
        )
        c_old = SignalCommit(
            head_sha="old",
            events=[self._ev("job", SignalStatus.SUCCESS, 1)],
        )
        s = Signal(key="job", workflow_name="wf", commits=[c_new, c_old])
        self.assertFalse(s.detect_fixed())

    def test_detect_recovered_skips_all_pending_then_success(self):
        # First commit is all pending; next has success -> recovered
        c_new = SignalCommit(
            head_sha="new",
            events=[self._ev("job", SignalStatus.PENDING, 1)],
        )
        c_mid = SignalCommit(
            head_sha="mid",
            events=[self._ev("job", SignalStatus.SUCCESS, 1)],
        )
        s = Signal(key="job", workflow_name="wf", commits=[c_new, c_mid])
        self.assertTrue(s.detect_fixed())

    def test_detect_flaky_true_on_same_commit_success_and_failure(self):
        c = SignalCommit(
            head_sha="sha",
            events=[
                self._ev("job", SignalStatus.SUCCESS, 1),
                self._ev("job", SignalStatus.FAILURE, 2),
            ],
        )
        s = Signal(key="job", workflow_name="wf", commits=[c])
        self.assertTrue(s.detect_flaky())

    def test_detect_flaky_false_when_separate_commits(self):
        c_new = SignalCommit(
            head_sha="new",
            events=[self._ev("job", SignalStatus.SUCCESS, 1)],
        )
        c_old = SignalCommit(
            head_sha="old",
            events=[self._ev("job", SignalStatus.FAILURE, 1)],
        )
        s = Signal(key="job", workflow_name="wf", commits=[c_new, c_old])
        self.assertFalse(s.detect_flaky())

    def test_confirm_not_an_infra_issue_true_on_sandwich(self):
        # Older commit has two successes at t=10 and t=30
        # Newer commit has a failure at t=20 (between) -> True
        c_new = SignalCommit(
            head_sha="new",
            events=[self._ev("job", SignalStatus.FAILURE, 20)],
        )
        c_old = SignalCommit(
            head_sha="old",
            events=[
                self._ev("job", SignalStatus.SUCCESS, 10),
                self._ev("job", SignalStatus.SUCCESS, 30),
            ],
        )
        partition = PartitionedCommits(failed=[c_new], unknown=[], successful=[c_old])
        self.assertEqual(
            partition.confirm_not_an_infra_issue(), InfraCheckResult.CONFIRMED
        )

    def test_confirm_not_an_infra_issue_none_with_pending_between(self):
        # Older has two successes; newer has pending between -> Maybe (None)
        c_new = SignalCommit(
            head_sha="new",
            events=[self._ev("job", SignalStatus.PENDING, 20)],
        )
        c_old = SignalCommit(
            head_sha="old",
            events=[
                self._ev("job", SignalStatus.SUCCESS, 10),
                self._ev("job", SignalStatus.SUCCESS, 30),
            ],
        )
        partition = PartitionedCommits(failed=[c_new], unknown=[], successful=[c_old])
        self.assertEqual(
            partition.confirm_not_an_infra_issue(), InfraCheckResult.PENDING
        )

    def test_confirm_not_an_infra_issue_false_when_pending_outside_window(self):
        # Older has two successes; newer has pending outside the [oldest, newest] success window -> False
        c_new = SignalCommit(
            head_sha="new",
            events=[self._ev("job", SignalStatus.PENDING, 35)],
        )
        c_old = SignalCommit(
            head_sha="old",
            events=[
                self._ev("job", SignalStatus.SUCCESS, 10),
                self._ev("job", SignalStatus.SUCCESS, 30),
            ],
        )
        partition = PartitionedCommits(failed=[c_new], unknown=[], successful=[c_old])
        self.assertEqual(
            partition.confirm_not_an_infra_issue(), InfraCheckResult.RESTART_SUCCESS
        )

    def test_confirm_not_an_infra_issue_false_no_bracketing_success(self):
        # Older has one success (t=10) and then pending to t=30; newer failure at t=40
        # Not within bracketing window -> False (and no maybe)
        c_new = SignalCommit(
            head_sha="new",
            events=[self._ev("job", SignalStatus.FAILURE, 40)],
        )
        c_old = SignalCommit(
            head_sha="old",
            events=[
                self._ev("job", SignalStatus.SUCCESS, 10),
                self._ev("job", SignalStatus.PENDING, 20),
                self._ev("job", SignalStatus.PENDING, 30),
            ],
        )
        partition = PartitionedCommits(failed=[c_new], unknown=[], successful=[c_old])
        self.assertEqual(
            partition.confirm_not_an_infra_issue(), InfraCheckResult.RESTART_SUCCESS
        )

    def test_detect_autorevert_pattern_basic(self):
        # Commits newest -> older. With 3 failures total, we meet the new 3+ threshold
        c_newest = SignalCommit(
            head_sha="sha_newest",
            events=[self._ev("job", SignalStatus.FAILURE, 7)],
        )
        c_newer = SignalCommit(
            head_sha="sha_newer",
            events=[self._ev("job", SignalStatus.FAILURE, 5)],
        )
        c_suspected = SignalCommit(
            head_sha="sha_mid",
            events=[self._ev("job", SignalStatus.FAILURE, 4)],
        )
        # base commit has two successes to confirm not infra
        c_base = SignalCommit(
            head_sha="sha_old",
            events=[
                self._ev("job", SignalStatus.SUCCESS, 3),
                self._ev("job", SignalStatus.SUCCESS, 6),
            ],
        )
        s = Signal(
            key="job",
            workflow_name="wf",
            commits=[c_newest, c_newer, c_suspected, c_base],
        )
        res = s.process_valid_autorevert_pattern()
        self.assertIsNotNone(res)
        self.assertIsInstance(res, AutorevertPattern)
        self.assertEqual(res.workflow_name, "wf")
        # newer failing commits are those after the suspected one (newest->older)
        self.assertEqual(res.newer_failing_commits, ["sha_newest", "sha_newer"])
        self.assertEqual(res.suspected_commit, "sha_mid")
        self.assertEqual(res.older_successful_commit, "sha_old")

    def test_detect_autorevert_pattern_ineligible_when_fixed(self):
        c_newer = SignalCommit(
            head_sha="sha_newer",
            events=[self._ev("job", SignalStatus.SUCCESS, 5)],
        )
        c_suspected = SignalCommit(
            head_sha="sha_mid",
            events=[self._ev("job", SignalStatus.FAILURE, 4)],
        )
        c_base = SignalCommit(
            head_sha="sha_old",
            events=[self._ev("job", SignalStatus.SUCCESS, 3)],
        )
        s = Signal(
            key="job", workflow_name="wf", commits=[c_newer, c_suspected, c_base]
        )
        res = s.process_valid_autorevert_pattern()
        self.assertIsInstance(res, Ineligible)
        self.assertEqual(res.reason, IneligibleReason.FIXED)

    def test_insufficient_failures_returns_restart_oldest_failed_when_no_pending(self):
        # Only one failure event overall (< 2) -> suggest restart of oldest failed
        c_failed = SignalCommit(
            head_sha="sha_failed",
            events=[self._ev("job", SignalStatus.FAILURE, 5)],
        )
        # Base successful commit with enough successes to avoid infra ambiguity
        c_base = SignalCommit(
            head_sha="sha_base",
            events=[
                self._ev("job", SignalStatus.SUCCESS, 3),
                self._ev("job", SignalStatus.SUCCESS, 7),
            ],
        )
        s = Signal(key="job", workflow_name="wf", commits=[c_failed, c_base])
        res = s.process_valid_autorevert_pattern()
        self.assertIsNotNone(res)
        # With insufficient failures, we never produce an AutorevertPattern
        self.assertNotIsInstance(res, AutorevertPattern)
        # Should propose a restart on the suspected failure side (oldest failed)
        self.assertTrue(hasattr(res, "commit_shas"))
        self.assertIn("sha_failed", res.commit_shas)

    def test_insufficient_failures_returns_insufficient_failures_when_pending_on_failed(
        self,
    ):
        # Only one failure overall, but the failed commit also has pending → ineligible due to insufficient failures
        c_failed_pending = SignalCommit(
            head_sha="sha_failed_pend",
            events=[
                self._ev("job", SignalStatus.PENDING, 4),
                self._ev("job", SignalStatus.FAILURE, 5),
            ],
        )
        c_base = SignalCommit(
            head_sha="sha_base",
            events=[
                self._ev("job", SignalStatus.SUCCESS, 3),
                self._ev("job", SignalStatus.SUCCESS, 7),
            ],
        )
        s = Signal(key="job", workflow_name="wf", commits=[c_failed_pending, c_base])
        res = s.process_valid_autorevert_pattern()
        self.assertIsInstance(res, Ineligible)
        # With pending on failed side and insufficient failures, we now return a specific reason
        self.assertEqual(res.reason, IneligibleReason.INSUFFICIENT_FAILURES)

    def test_insufficient_successes_returns_restart_newest_success_when_no_pending(
        self,
    ):
        # Ensure we have at least three failure events to avoid the failure-side heuristic
        c_fail_newest = SignalCommit(
            head_sha="sha_fail_newest",
            events=[self._ev("job", SignalStatus.FAILURE, 11)],
        )
        c_fail_new = SignalCommit(
            head_sha="sha_fail_new",
            events=[self._ev("job", SignalStatus.FAILURE, 10)],
        )
        c_fail_old = SignalCommit(
            head_sha="sha_fail_old",
            events=[self._ev("job", SignalStatus.FAILURE, 9)],
        )
        # Only one success event overall (< 2) → suggest restart of newest successful
        c_success = SignalCommit(
            head_sha="sha_success",
            events=[self._ev("job", SignalStatus.SUCCESS, 3)],
        )
        s = Signal(
            key="job",
            workflow_name="wf",
            commits=[c_fail_newest, c_fail_new, c_fail_old, c_success],
        )
        res = s.process_valid_autorevert_pattern()
        self.assertIsNotNone(res)
        # With insufficient successes, we never produce an AutorevertPattern
        self.assertNotIsInstance(res, AutorevertPattern)
        # Should propose a restart on the suspected success side (newest successful)
        self.assertTrue(hasattr(res, "commit_shas"))
        self.assertIn("sha_success", res.commit_shas)

    def test_insufficient_successes_returns_specific_reason_when_pending_on_success(
        self,
    ):
        # Three failures present, but newest successful has pending → ineligible due to insufficient successes
        c_fail_newest = SignalCommit(
            head_sha="sha_fail_newest",
            events=[self._ev("job", SignalStatus.FAILURE, 11)],
        )
        c_fail_new = SignalCommit(
            head_sha="sha_fail_new",
            events=[self._ev("job", SignalStatus.FAILURE, 10)],
        )
        c_fail_old = SignalCommit(
            head_sha="sha_fail_old",
            events=[self._ev("job", SignalStatus.FAILURE, 9)],
        )
        c_success_pending = SignalCommit(
            head_sha="sha_success_pend",
            events=[
                self._ev("job", SignalStatus.SUCCESS, 3),
                self._ev("job", SignalStatus.PENDING, 8),
            ],
        )
        s = Signal(
            key="job",
            workflow_name="wf",
            commits=[c_fail_newest, c_fail_new, c_fail_old, c_success_pending],
        )
        res = s.process_valid_autorevert_pattern()
        self.assertIsInstance(res, Ineligible)
        # Reason switches from INFRA_NOT_CONFIRMED to an explicit insufficient_successes
        self.assertEqual(res.reason, IneligibleReason.INSUFFICIENT_SUCCESSES)

    def test_both_sides_restart_accumulate_when_below_thresholds(self):
        # One failure total (<3) and one success total (<2), neither pending.
        # Should propose restarts for both oldest failed and newest successful.
        c_failed = SignalCommit(
            head_sha="sha_failed",
            events=[self._ev("job", SignalStatus.FAILURE, 10)],
        )
        c_success = SignalCommit(
            head_sha="sha_success",
            events=[self._ev("job", SignalStatus.SUCCESS, 3)],
        )
        s = Signal(
            key="job",
            workflow_name="wf",
            commits=[c_failed, c_success],
        )
        res = s.process_valid_autorevert_pattern()
        # Should be a RestartCommits with both SHAs present
        self.assertTrue(hasattr(res, "commit_shas"))
        self.assertIn("sha_failed", res.commit_shas)
        self.assertIn("sha_success", res.commit_shas)

    def test_success_restart_even_when_failed_side_pending_and_insufficient_failures(
        self,
    ):
        # Scenario to cover gap:
        # - Only one failed event on the failed side, and that failed commit also has a pending event
        # - Success side has successes that are earlier than failure (so infra check yields RESTART_SUCCESS)
        # Expected: restart is still proposed on the success side (due to infra check),
        # even though failures < 3 and the failed commit is pending.

        # Failed (newer): has PENDING and then FAILURE
        c_failed_pending = SignalCommit(
            head_sha="sha_fail_pend",
            events=[
                self._ev("job", SignalStatus.PENDING, 5),
                self._ev("job", SignalStatus.FAILURE, 6),
            ],
        )
        # Successful (older): two successes earlier than any failure/pending, not pending
        c_success_ok = SignalCommit(
            head_sha="sha_success_ok",
            events=[
                self._ev("job", SignalStatus.SUCCESS, 2),
                self._ev("job", SignalStatus.SUCCESS, 4),
            ],
        )
        s = Signal(
            key="job",
            workflow_name="wf",
            commits=[c_failed_pending, c_success_ok],  # newest -> older
        )
        res = s.process_valid_autorevert_pattern()
        # Should be a RestartCommits proposing restart on the success side only
        self.assertNotIsInstance(res, AutorevertPattern)
        self.assertTrue(hasattr(res, "commit_shas"))
        self.assertIn("sha_success_ok", res.commit_shas)
        self.assertNotIn("sha_fail_pend", res.commit_shas)


if __name__ == "__main__":
    unittest.main()
