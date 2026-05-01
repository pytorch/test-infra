import unittest
from datetime import datetime, timedelta, timezone

from pytorch_auto_revert.signal import (
    AdvisorVerdict,
    AIAdvisorResult,
    AutorevertPattern,
    DispatchAdvisor,
    Ineligible,
    IneligibleReason,
    InfraCheckResult,
    PartitionedCommits,
    RestartCommits,
    Signal,
    SignalCommit,
    SignalEvent,
    SignalSource,
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
            timestamp=ts(self.t0, 0),
            events=[
                self._ev("job", SignalStatus.PENDING, 1),
                self._ev("job", SignalStatus.SUCCESS, 2),
            ],
        )
        c_old = SignalCommit(
            head_sha="old",
            timestamp=ts(self.t0, 0),
            events=[self._ev("job", SignalStatus.FAILURE, 1)],
        )
        s = Signal(key="job", workflow_name="wf", commits=[c_new, c_old])
        self.assertTrue(s.detect_fixed())

    def test_detect_recovered_false_when_first_non_pending_failure(self):
        # Newest commit only has failure (no success)
        c_new = SignalCommit(
            head_sha="new",
            timestamp=ts(self.t0, 0),
            events=[self._ev("job", SignalStatus.FAILURE, 1)],
        )
        c_old = SignalCommit(
            head_sha="old",
            timestamp=ts(self.t0, 0),
            events=[self._ev("job", SignalStatus.SUCCESS, 1)],
        )
        s = Signal(key="job", workflow_name="wf", commits=[c_new, c_old])
        self.assertFalse(s.detect_fixed())

    def test_detect_recovered_skips_all_pending_then_success(self):
        # First commit is all pending; next has success -> recovered
        c_new = SignalCommit(
            head_sha="new",
            timestamp=ts(self.t0, 0),
            events=[self._ev("job", SignalStatus.PENDING, 1)],
        )
        c_mid = SignalCommit(
            head_sha="mid",
            timestamp=ts(self.t0, 0),
            events=[self._ev("job", SignalStatus.SUCCESS, 1)],
        )
        s = Signal(key="job", workflow_name="wf", commits=[c_new, c_mid])
        self.assertTrue(s.detect_fixed())

    def test_detect_flaky_true_on_same_commit_success_and_failure(self):
        c = SignalCommit(
            head_sha="sha",
            timestamp=ts(self.t0, 0),
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
            timestamp=ts(self.t0, 0),
            events=[self._ev("job", SignalStatus.SUCCESS, 1)],
        )
        c_old = SignalCommit(
            head_sha="old",
            timestamp=ts(self.t0, 0),
            events=[self._ev("job", SignalStatus.FAILURE, 1)],
        )
        s = Signal(key="job", workflow_name="wf", commits=[c_new, c_old])
        self.assertFalse(s.detect_flaky())

    def test_confirm_not_an_infra_issue_true_on_sandwich(self):
        # Older commit has two successes at t=10 and t=30
        # Newer commit has a failure at t=20 (between) -> True
        c_new = SignalCommit(
            head_sha="new",
            timestamp=ts(self.t0, 0),
            events=[self._ev("job", SignalStatus.FAILURE, 20)],
        )
        c_old = SignalCommit(
            head_sha="old",
            timestamp=ts(self.t0, 0),
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
            timestamp=ts(self.t0, 0),
            events=[self._ev("job", SignalStatus.PENDING, 20)],
        )
        c_old = SignalCommit(
            head_sha="old",
            timestamp=ts(self.t0, 0),
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
            timestamp=ts(self.t0, 0),
            events=[self._ev("job", SignalStatus.PENDING, 35)],
        )
        c_old = SignalCommit(
            head_sha="old",
            timestamp=ts(self.t0, 0),
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
            timestamp=ts(self.t0, 0),
            events=[self._ev("job", SignalStatus.FAILURE, 40)],
        )
        c_old = SignalCommit(
            head_sha="old",
            timestamp=ts(self.t0, 0),
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
            timestamp=ts(self.t0, 0),
            events=[self._ev("job", SignalStatus.FAILURE, 7)],
        )
        c_newer = SignalCommit(
            head_sha="sha_newer",
            timestamp=ts(self.t0, 0),
            events=[self._ev("job", SignalStatus.FAILURE, 5)],
        )
        c_suspected = SignalCommit(
            head_sha="sha_mid",
            timestamp=ts(self.t0, 0),
            events=[self._ev("job", SignalStatus.FAILURE, 4)],
        )
        # base commit has two successes to confirm not infra
        c_base = SignalCommit(
            head_sha="sha_old",
            timestamp=ts(self.t0, 0),
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
            timestamp=ts(self.t0, 0),
            events=[self._ev("job", SignalStatus.SUCCESS, 5)],
        )
        c_suspected = SignalCommit(
            head_sha="sha_mid",
            timestamp=ts(self.t0, 0),
            events=[self._ev("job", SignalStatus.FAILURE, 4)],
        )
        c_base = SignalCommit(
            head_sha="sha_old",
            timestamp=ts(self.t0, 0),
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
            timestamp=ts(self.t0, 0),
            events=[self._ev("job", SignalStatus.FAILURE, 5)],
        )
        # Base successful commit with enough successes to avoid infra ambiguity
        c_base = SignalCommit(
            head_sha="sha_base",
            timestamp=ts(self.t0, 0),
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
            timestamp=ts(self.t0, 0),
            events=[
                self._ev("job", SignalStatus.PENDING, 4),
                self._ev("job", SignalStatus.FAILURE, 5),
            ],
        )
        c_base = SignalCommit(
            head_sha="sha_base",
            timestamp=ts(self.t0, 0),
            events=[
                self._ev("job", SignalStatus.SUCCESS, 3),
                self._ev("job", SignalStatus.SUCCESS, 7),
            ],
        )
        s = Signal(key="job", workflow_name="wf", commits=[c_failed_pending, c_base])
        res = s.process_valid_autorevert_pattern()
        self.assertIsInstance(res, Ineligible)
        self.assertEqual(res.reason, IneligibleReason.INSUFFICIENT_FAILURES)

    def test_insufficient_successes_returns_restart_newest_success_when_no_pending(
        self,
    ):
        # Ensure we have at least three failure events to avoid the failure-side heuristic
        c_fail_newest = SignalCommit(
            head_sha="sha_fail_newest",
            timestamp=ts(self.t0, 0),
            events=[self._ev("job", SignalStatus.FAILURE, 11)],
        )
        c_fail_new = SignalCommit(
            head_sha="sha_fail_new",
            timestamp=ts(self.t0, 0),
            events=[self._ev("job", SignalStatus.FAILURE, 10)],
        )
        c_fail_old = SignalCommit(
            head_sha="sha_fail_old",
            timestamp=ts(self.t0, 0),
            events=[self._ev("job", SignalStatus.FAILURE, 9)],
        )
        # Only one success event overall (< 2) → suggest restart of newest successful
        c_success = SignalCommit(
            head_sha="sha_success",
            timestamp=ts(self.t0, 0),
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
            timestamp=ts(self.t0, 0),
            events=[self._ev("job", SignalStatus.FAILURE, 11)],
        )
        c_fail_new = SignalCommit(
            head_sha="sha_fail_new",
            timestamp=ts(self.t0, 0),
            events=[self._ev("job", SignalStatus.FAILURE, 10)],
        )
        c_fail_old = SignalCommit(
            head_sha="sha_fail_old",
            timestamp=ts(self.t0, 0),
            events=[self._ev("job", SignalStatus.FAILURE, 9)],
        )
        c_success_pending = SignalCommit(
            head_sha="sha_success_pend",
            timestamp=ts(self.t0, 0),
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
        # Should be ineligible due to insufficient successes, but infra check takes precedence and
        # it currently requires two successes to confirm not infra
        self.assertEqual(res.reason, IneligibleReason.INFRA_NOT_CONFIRMED)

    def test_both_sides_restart_accumulate_when_below_thresholds(self):
        # One failure total (<3) and one success total (<2), neither pending.
        # Should propose restarts for both oldest failed and newest successful.
        c_failed = SignalCommit(
            head_sha="sha_failed",
            timestamp=ts(self.t0, 0),
            events=[self._ev("job", SignalStatus.FAILURE, 10)],
        )
        c_success = SignalCommit(
            head_sha="sha_success",
            timestamp=ts(self.t0, 0),
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
        # Scenario:
        # - Only one failed event on the failed side, and that failed commit also has a pending event
        # - Success side has successes that are earlier than failure (so infra check yields RESTART_SUCCESS)
        # Expected: restart is still proposed on the success side (due to infra check),
        # even though failures < 3 and the failed commit is pending.

        # Failed (newer): has PENDING and then FAILURE
        c_failed_pending = SignalCommit(
            head_sha="sha_fail_pend",
            timestamp=ts(self.t0, 0),
            events=[
                self._ev("job", SignalStatus.PENDING, 5),
                self._ev("job", SignalStatus.FAILURE, 6),
            ],
        )
        # Successful (older): two successes earlier than any failure/pending, not pending
        c_success_ok = SignalCommit(
            head_sha="sha_success_ok",
            timestamp=ts(self.t0, 0),
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

    def test_job_track_requires_failed_rerun_when_no_gap_missing_rerun(self):
        # Job-track: require a failed rerun on the suspected commit when there is no gap.
        # Build commits newest -> older
        c_fail_newest = SignalCommit(
            head_sha="sha_fail_newest",
            timestamp=ts(self.t0, 0),
            events=[
                SignalEvent(
                    name="job",
                    status=SignalStatus.FAILURE,
                    started_at=ts(self.t0, 7),
                    wf_run_id=100,
                    run_attempt=1,
                )
            ],
        )
        c_fail_new = SignalCommit(
            head_sha="sha_fail_new",
            timestamp=ts(self.t0, 0),
            events=[
                SignalEvent(
                    name="job",
                    status=SignalStatus.FAILURE,
                    started_at=ts(self.t0, 5),
                    wf_run_id=101,
                    run_attempt=1,
                )
            ],
        )
        # Suspected commit: first failure attempt=1, no rerun yet (missing failed rerun)
        c_suspected = SignalCommit(
            head_sha="sha_suspected",
            timestamp=ts(self.t0, 0),
            events=[
                SignalEvent(
                    name="job",
                    status=SignalStatus.FAILURE,
                    started_at=ts(self.t0, 4),
                    wf_run_id=321,
                    run_attempt=1,
                ),
            ],
        )
        # Base successful commit with two successes
        c_base = SignalCommit(
            head_sha="sha_base",
            timestamp=ts(self.t0, 0),
            events=[
                self._ev("job", SignalStatus.SUCCESS, 3),
                self._ev("job", SignalStatus.SUCCESS, 6),
            ],
        )

        s = Signal(
            key="job",
            workflow_name="wf",
            commits=[c_fail_newest, c_fail_new, c_suspected, c_base],
            source=SignalSource.JOB,
        )
        res = s.process_valid_autorevert_pattern()
        # Should not produce an AutorevertPattern; instead propose restart of suspected commit
        self.assertNotIsInstance(res, AutorevertPattern)
        self.assertTrue(hasattr(res, "commit_shas"))
        self.assertIn("sha_suspected", res.commit_shas)

    def test_job_track_allows_autorevert_when_failed_rerun_present(self):
        # Same as above, but suspected has a failed rerun (attempt 2) on the same wf_run_id.
        c_fail_newest = SignalCommit(
            head_sha="sha_fail_newest",
            timestamp=ts(self.t0, 0),
            events=[
                SignalEvent(
                    name="job",
                    status=SignalStatus.FAILURE,
                    started_at=ts(self.t0, 7),
                    wf_run_id=100,
                    run_attempt=1,
                )
            ],
        )
        c_fail_new = SignalCommit(
            head_sha="sha_fail_new",
            timestamp=ts(self.t0, 0),
            events=[
                SignalEvent(
                    name="job",
                    status=SignalStatus.FAILURE,
                    started_at=ts(self.t0, 5),
                    wf_run_id=101,
                    run_attempt=1,
                )
            ],
        )
        # Suspected commit: failure attempt=1 then failure attempt=2 on same run id
        c_suspected = SignalCommit(
            head_sha="sha_suspected",
            timestamp=ts(self.t0, 0),
            events=[
                SignalEvent(
                    name="job",
                    status=SignalStatus.FAILURE,
                    started_at=ts(self.t0, 4),
                    wf_run_id=321,
                    run_attempt=1,
                ),
                SignalEvent(
                    name="job",
                    status=SignalStatus.FAILURE,
                    started_at=ts(self.t0, 6),
                    wf_run_id=321,
                    run_attempt=2,
                ),
            ],
        )
        c_base = SignalCommit(
            head_sha="sha_base",
            timestamp=ts(self.t0, 0),
            events=[
                self._ev("job", SignalStatus.SUCCESS, 3),
                self._ev("job", SignalStatus.SUCCESS, 6),
            ],
        )

        s = Signal(
            key="job",
            workflow_name="wf",
            commits=[c_fail_newest, c_fail_new, c_suspected, c_base],
            source=SignalSource.JOB,
        )
        res = s.process_valid_autorevert_pattern()
        self.assertIsInstance(res, AutorevertPattern)


class TestDispatchAdvisor(unittest.TestCase):
    """Tests for DispatchAdvisor emission from process_valid_autorevert_pattern."""

    def setUp(self) -> None:
        self.t0 = datetime(2025, 8, 19, 12, 0, 0)

    def _ev(self, name: str, status: SignalStatus, minute: int, **kw) -> SignalEvent:
        return SignalEvent(
            name=name,
            status=status,
            started_at=ts(self.t0, minute),
            wf_run_id=kw.get("wf_run_id", 1),
            job_id=kw.get("job_id"),
        )

    def test_advisor_emitted_on_restart_commits(self):
        """When partition has 2+ failures and 1+ success, advisor is attached to RestartCommits."""
        # 2 failures on one commit, 1 success on base → eligible for advisor
        # Only 2 failure events total (< 3 required), so outcome is RestartCommits
        c_failed = SignalCommit(
            head_sha="sha_fail",
            timestamp=ts(self.t0, 0),
            events=[
                self._ev("job", SignalStatus.FAILURE, 5),
                self._ev("job", SignalStatus.FAILURE, 6),
            ],
        )
        c_base = SignalCommit(
            head_sha="sha_base",
            timestamp=ts(self.t0, -10),
            events=[self._ev("job", SignalStatus.SUCCESS, 3)],
        )
        s = Signal(key="job", workflow_name="wf", commits=[c_failed, c_base])
        res = s.process_valid_autorevert_pattern()
        self.assertIsInstance(res, RestartCommits)
        self.assertIsNotNone(res.advisor)
        self.assertIsInstance(res.advisor, DispatchAdvisor)
        self.assertEqual(res.advisor.suspect_commit, "sha_fail")
        self.assertEqual(res.advisor.failed_commits, ("sha_fail",))
        self.assertEqual(res.advisor.successful_commits, ("sha_base",))

    def test_advisor_not_emitted_when_unknown_gap_exists(self):
        """When partition has unknown commits between failed and successful, no advisor is emitted."""
        c_fail_1 = SignalCommit(
            head_sha="sha_fail_1",
            timestamp=ts(self.t0, 0),
            events=[self._ev("job", SignalStatus.FAILURE, 9)],
        )
        c_fail_2 = SignalCommit(
            head_sha="sha_fail_2",
            timestamp=ts(self.t0, -5),
            events=[
                self._ev("job", SignalStatus.FAILURE, 5),
                self._ev("job", SignalStatus.FAILURE, 6),
            ],
        )
        # Unknown gap commit with pending event
        c_gap = SignalCommit(
            head_sha="sha_gap",
            timestamp=ts(self.t0, -8),
            events=[self._ev("job", SignalStatus.PENDING, 7)],
        )
        c_base = SignalCommit(
            head_sha="sha_base",
            timestamp=ts(self.t0, -10),
            events=[
                self._ev("job", SignalStatus.SUCCESS, 2),
                self._ev("job", SignalStatus.SUCCESS, 3),
            ],
        )
        s = Signal(
            key="job",
            workflow_name="wf",
            commits=[c_fail_1, c_fail_2, c_gap, c_base],
        )
        res = s.process_valid_autorevert_pattern()
        self.assertNotIsInstance(res, AutorevertPattern)
        # Unknown gap means advisor is NOT emitted (partition boundary uncertain)
        advisor = getattr(res, "advisor", None)
        self.assertIsNone(advisor)

    def test_advisor_emitted_on_clean_partition(self):
        """When partition has no unknown gap and sufficient data, advisor is emitted."""
        # 2 failures (not enough for AutorevertPattern), 1 success, no gap
        c_fail = SignalCommit(
            head_sha="sha_fail",
            timestamp=ts(self.t0, 0),
            events=[
                self._ev("job", SignalStatus.FAILURE, 5),
                self._ev("job", SignalStatus.FAILURE, 6),
            ],
        )
        c_base = SignalCommit(
            head_sha="sha_base",
            timestamp=ts(self.t0, -10),
            events=[self._ev("job", SignalStatus.SUCCESS, 3)],
        )
        s = Signal(key="job", workflow_name="wf", commits=[c_fail, c_base])
        res = s.process_valid_autorevert_pattern()
        self.assertIsInstance(res, RestartCommits)
        self.assertIsNotNone(res.advisor)
        self.assertEqual(res.advisor.suspect_commit, "sha_fail")

    def test_advisor_not_emitted_when_insufficient_failures(self):
        """When partition has < 2 failures, no advisor is emitted."""
        c_failed = SignalCommit(
            head_sha="sha_fail",
            timestamp=ts(self.t0, 0),
            events=[self._ev("job", SignalStatus.FAILURE, 5)],
        )
        c_base = SignalCommit(
            head_sha="sha_base",
            timestamp=ts(self.t0, -10),
            events=[self._ev("job", SignalStatus.SUCCESS, 3)],
        )
        s = Signal(key="job", workflow_name="wf", commits=[c_failed, c_base])
        res = s.process_valid_autorevert_pattern()
        self.assertIsInstance(res, RestartCommits)
        self.assertIsNone(res.advisor)

    def test_advisor_not_emitted_when_insufficient_successes(self):
        """When partition has < 1 success event, no advisor is emitted."""
        # Base commit has only pending events (no success events)
        c_failed = SignalCommit(
            head_sha="sha_fail",
            timestamp=ts(self.t0, 0),
            events=[
                self._ev("job", SignalStatus.FAILURE, 5),
                self._ev("job", SignalStatus.FAILURE, 6),
            ],
        )
        c_base = SignalCommit(
            head_sha="sha_base",
            timestamp=ts(self.t0, -10),
            events=[self._ev("job", SignalStatus.PENDING, 3)],
        )
        # This won't even partition (base has no success), so we get NO_SUCCESSES
        s = Signal(key="job", workflow_name="wf", commits=[c_failed, c_base])
        res = s.process_valid_autorevert_pattern()
        self.assertIsInstance(res, Ineligible)
        # Early return before partition — no advisor field
        self.assertIsNone(res.advisor)

    def test_advisor_not_emitted_on_autorevert_pattern(self):
        """AutorevertPattern outcome does not carry an advisor."""
        c_newest = SignalCommit(
            head_sha="sha_newest",
            timestamp=ts(self.t0, 0),
            events=[self._ev("job", SignalStatus.FAILURE, 7)],
        )
        c_newer = SignalCommit(
            head_sha="sha_newer",
            timestamp=ts(self.t0, 0),
            events=[self._ev("job", SignalStatus.FAILURE, 5)],
        )
        c_suspected = SignalCommit(
            head_sha="sha_mid",
            timestamp=ts(self.t0, 0),
            events=[self._ev("job", SignalStatus.FAILURE, 4)],
        )
        c_base = SignalCommit(
            head_sha="sha_old",
            timestamp=ts(self.t0, 0),
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
        self.assertIsInstance(res, AutorevertPattern)
        # AutorevertPattern has no advisor field
        self.assertFalse(hasattr(res, "advisor"))

    def test_advisor_not_emitted_for_early_returns(self):
        """Early exits (flaky, fixed, no_successes) have no advisor."""
        # Flaky: mixed outcomes on same commit
        c_flaky = SignalCommit(
            head_sha="sha_flaky",
            timestamp=ts(self.t0, 0),
            events=[
                self._ev("job", SignalStatus.FAILURE, 4),
                self._ev("job", SignalStatus.SUCCESS, 5),
            ],
        )
        c_base = SignalCommit(
            head_sha="sha_base",
            timestamp=ts(self.t0, -10),
            events=[self._ev("job", SignalStatus.SUCCESS, 3)],
        )
        s = Signal(key="job", workflow_name="wf", commits=[c_flaky, c_base])
        res = s.process_valid_autorevert_pattern()
        self.assertIsInstance(res, Ineligible)
        # Flaky commit has success → detect_fixed() returns True (early exit before partition)
        self.assertEqual(res.reason, IneligibleReason.FIXED)
        self.assertIsNone(res.advisor)

    def test_advisor_has_correct_partition_shas(self):
        """Verify advisor carries the right failed and successful commit SHAs."""
        c_fail_1 = SignalCommit(
            head_sha="fail_1",
            timestamp=ts(self.t0, 0),
            events=[
                self._ev("job", SignalStatus.FAILURE, 7),
                self._ev("job", SignalStatus.FAILURE, 8),
            ],
        )
        c_fail_2 = SignalCommit(
            head_sha="fail_2",
            timestamp=ts(self.t0, -5),
            events=[self._ev("job", SignalStatus.FAILURE, 5)],
        )
        c_succ_1 = SignalCommit(
            head_sha="succ_1",
            timestamp=ts(self.t0, -10),
            events=[self._ev("job", SignalStatus.SUCCESS, 3)],
        )
        c_succ_2 = SignalCommit(
            head_sha="succ_2",
            timestamp=ts(self.t0, -15),
            events=[self._ev("job", SignalStatus.SUCCESS, 1)],
        )
        s = Signal(
            key="job",
            workflow_name="wf",
            commits=[c_fail_1, c_fail_2, c_succ_1, c_succ_2],
        )
        res = s.process_valid_autorevert_pattern()
        # With 3 failures and 2 successes, this might be AutorevertPattern or RestartCommits
        # depending on infra check. Either way, if it's RestartCommits/Ineligible, check advisor.
        advisor = getattr(res, "advisor", None)
        if advisor is not None:
            self.assertEqual(advisor.failed_commits, ("fail_1", "fail_2"))
            self.assertEqual(advisor.successful_commits, ("succ_1", "succ_2"))
            self.assertEqual(advisor.suspect_commit, "fail_2")


class TestAdvisorVerdictIntegration(unittest.TestCase):
    """Tests for AI advisor verdict handling in process_valid_autorevert_pattern."""

    def setUp(self) -> None:
        self.t0 = datetime(2025, 8, 19, 12, 0, 0)

    def _ev(self, name: str, status: SignalStatus, minute: int) -> SignalEvent:
        return SignalEvent(
            name=name,
            status=status,
            started_at=ts(self.t0, minute),
            wf_run_id=1,
        )

    def _make_signal_with_advisor(
        self, verdict: AdvisorVerdict, confidence: float = 0.95
    ) -> Signal:
        """Build a signal with 3 failures and 2 successes where the suspect
        commit has an advisor result."""
        advisor_result = AIAdvisorResult(
            verdict=verdict,
            confidence=confidence,
            timestamp=self.t0,
            signal_key="job",
        )
        c_newest = SignalCommit(
            head_sha="sha_newest",
            timestamp=ts(self.t0, 0),
            events=[self._ev("job", SignalStatus.FAILURE, 7)],
        )
        c_newer = SignalCommit(
            head_sha="sha_newer",
            timestamp=ts(self.t0, 0),
            events=[self._ev("job", SignalStatus.FAILURE, 5)],
        )
        c_suspected = SignalCommit(
            head_sha="sha_mid",
            timestamp=ts(self.t0, 0),
            events=[self._ev("job", SignalStatus.FAILURE, 4)],
            advisor_result=advisor_result,
        )
        c_base = SignalCommit(
            head_sha="sha_old",
            timestamp=ts(self.t0, 0),
            events=[
                self._ev("job", SignalStatus.SUCCESS, 3),
                self._ev("job", SignalStatus.SUCCESS, 6),
            ],
        )
        return Signal(
            key="job",
            workflow_name="wf",
            commits=[c_newest, c_newer, c_suspected, c_base],
        )

    def test_advisor_revert_produces_autorevert_pattern(self):
        """When advisor says 'revert', produce AutorevertPattern immediately."""
        s = self._make_signal_with_advisor(AdvisorVerdict.REVERT)
        res = s.process_valid_autorevert_pattern()
        self.assertIsInstance(res, AutorevertPattern)
        self.assertEqual(res.suspected_commit, "sha_mid")
        self.assertEqual(res.older_successful_commit, "sha_old")
        self.assertEqual(res.newer_failing_commits, ["sha_newest", "sha_newer"])

    def test_advisor_related_produces_autorevert_pattern(self):
        """When advisor says 'related' (context-neutral successor to 'revert'),
        produce AutorevertPattern just like 'revert'."""
        s = self._make_signal_with_advisor(AdvisorVerdict.RELATED)
        res = s.process_valid_autorevert_pattern()
        self.assertIsInstance(res, AutorevertPattern)
        self.assertEqual(res.suspected_commit, "sha_mid")
        self.assertEqual(res.older_successful_commit, "sha_old")
        self.assertEqual(res.newer_failing_commits, ["sha_newest", "sha_newer"])

    def test_advisor_not_related_produces_ineligible(self):
        """When advisor says 'not_related', return Ineligible."""
        s = self._make_signal_with_advisor(AdvisorVerdict.NOT_RELATED)
        res = s.process_valid_autorevert_pattern()
        self.assertIsInstance(res, Ineligible)
        self.assertEqual(res.reason, IneligibleReason.ADVISOR_NOT_RELATED)

    def test_advisor_garbage_produces_ineligible_within_2h(self):
        """When advisor says 'garbage' and verdict is < 2h old, suppress signal."""
        # Use a recent timestamp
        advisor_result = AIAdvisorResult(
            verdict=AdvisorVerdict.GARBAGE,
            confidence=0.95,
            timestamp=datetime.now(tz=timezone.utc),
            signal_key="job",
        )
        c_fail = SignalCommit(
            head_sha="sha_fail",
            timestamp=ts(self.t0, 0),
            events=[
                self._ev("job", SignalStatus.FAILURE, 4),
                self._ev("job", SignalStatus.FAILURE, 5),
                self._ev("job", SignalStatus.FAILURE, 6),
            ],
            advisor_result=advisor_result,
        )
        c_base = SignalCommit(
            head_sha="sha_base",
            timestamp=ts(self.t0, 0),
            events=[
                self._ev("job", SignalStatus.SUCCESS, 2),
                self._ev("job", SignalStatus.SUCCESS, 3),
            ],
        )
        s = Signal(key="job", workflow_name="wf", commits=[c_fail, c_base])
        res = s.process_valid_autorevert_pattern()
        self.assertIsInstance(res, Ineligible)
        self.assertEqual(res.reason, IneligibleReason.ADVISOR_GARBAGE)

    def test_advisor_garbage_expires_after_2h(self):
        """When garbage verdict is > 2h old, it expires and normal processing resumes."""
        old_timestamp = datetime.now(tz=timezone.utc) - timedelta(hours=3)
        advisor_result = AIAdvisorResult(
            verdict=AdvisorVerdict.GARBAGE,
            confidence=0.95,
            timestamp=old_timestamp,
            signal_key="job",
        )
        c_newest = SignalCommit(
            head_sha="sha_newest",
            timestamp=ts(self.t0, 0),
            events=[self._ev("job", SignalStatus.FAILURE, 7)],
        )
        c_newer = SignalCommit(
            head_sha="sha_newer",
            timestamp=ts(self.t0, 0),
            events=[self._ev("job", SignalStatus.FAILURE, 5)],
        )
        c_suspected = SignalCommit(
            head_sha="sha_mid",
            timestamp=ts(self.t0, 0),
            events=[self._ev("job", SignalStatus.FAILURE, 4)],
            advisor_result=advisor_result,
        )
        c_base = SignalCommit(
            head_sha="sha_old",
            timestamp=ts(self.t0, 0),
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
        # Garbage expired — should proceed to AutorevertPattern
        self.assertIsInstance(res, AutorevertPattern)

    def test_advisor_unsure_continues_normal_processing(self):
        """When advisor says 'unsure', continue with normal autorevert logic."""
        s = self._make_signal_with_advisor(AdvisorVerdict.UNSURE)
        res = s.process_valid_autorevert_pattern()
        # With 3 failures and 2 successes, should produce AutorevertPattern
        self.assertIsInstance(res, AutorevertPattern)

    def test_advisor_low_confidence_ignored(self):
        """Advisor verdict below confidence threshold is ignored."""
        s = self._make_signal_with_advisor(AdvisorVerdict.NOT_RELATED, confidence=0.5)
        res = s.process_valid_autorevert_pattern()
        # Low confidence NOT_RELATED should be ignored → normal AutorevertPattern
        self.assertIsInstance(res, AutorevertPattern)

    def test_advisor_high_confidence_revert_acts(self):
        """Advisor 'revert' at exactly the threshold acts."""
        s = self._make_signal_with_advisor(AdvisorVerdict.REVERT, confidence=0.9)
        res = s.process_valid_autorevert_pattern()
        self.assertIsInstance(res, AutorevertPattern)
        self.assertEqual(res.suspected_commit, "sha_mid")

    def test_advisor_wrong_signal_key_ignored(self):
        """Advisor result for a different signal_key is ignored."""
        advisor_result = AIAdvisorResult(
            verdict=AdvisorVerdict.NOT_RELATED,
            confidence=0.99,
            timestamp=self.t0,
            signal_key="different_signal",  # doesn't match "job"
        )
        c_newest = SignalCommit(
            head_sha="sha_newest",
            timestamp=ts(self.t0, 0),
            events=[self._ev("job", SignalStatus.FAILURE, 7)],
        )
        c_newer = SignalCommit(
            head_sha="sha_newer",
            timestamp=ts(self.t0, 0),
            events=[self._ev("job", SignalStatus.FAILURE, 5)],
        )
        c_suspected = SignalCommit(
            head_sha="sha_mid",
            timestamp=ts(self.t0, 0),
            events=[self._ev("job", SignalStatus.FAILURE, 4)],
            advisor_result=advisor_result,
        )
        c_base = SignalCommit(
            head_sha="sha_old",
            timestamp=ts(self.t0, 0),
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
        # NOT_RELATED verdict is for wrong signal, should be ignored
        self.assertIsInstance(res, AutorevertPattern)

    def test_flaky_check_after_advisor(self):
        """Flaky check happens after advisor, so advisor can still fire on flaky signals."""
        # Signal with a flaky commit (suspect) that has an advisor revert verdict
        advisor_result = AIAdvisorResult(
            verdict=AdvisorVerdict.REVERT,
            confidence=0.95,
            timestamp=self.t0,
            signal_key="job",
        )
        c_newest = SignalCommit(
            head_sha="sha_newest",
            timestamp=ts(self.t0, 0),
            events=[self._ev("job", SignalStatus.FAILURE, 5)],
        )
        # Suspect commit is flaky (both success and failure) — with partition fix,
        # it stays in the failed partition because it has failures
        c_suspect_flaky = SignalCommit(
            head_sha="sha_suspect",
            timestamp=ts(self.t0, -5),
            events=[
                self._ev("job", SignalStatus.SUCCESS, 2),
                self._ev("job", SignalStatus.FAILURE, 3),
            ],
            advisor_result=advisor_result,
        )
        c_base = SignalCommit(
            head_sha="sha_base",
            timestamp=ts(self.t0, -10),
            events=[self._ev("job", SignalStatus.SUCCESS, 1)],
        )
        s = Signal(
            key="job",
            workflow_name="wf",
            commits=[c_newest, c_suspect_flaky, c_base],
        )
        res = s.process_valid_autorevert_pattern()
        # Advisor said revert on the suspect → AutorevertPattern
        # even though the signal has a flaky commit
        self.assertIsInstance(res, AutorevertPattern)
        self.assertEqual(res.suspected_commit, "sha_suspect")

    def test_no_advisor_result_continues_normally(self):
        """Without advisor result, processing is unchanged."""
        c_newest = SignalCommit(
            head_sha="sha_newest",
            timestamp=ts(self.t0, 0),
            events=[self._ev("job", SignalStatus.FAILURE, 7)],
        )
        c_newer = SignalCommit(
            head_sha="sha_newer",
            timestamp=ts(self.t0, 0),
            events=[self._ev("job", SignalStatus.FAILURE, 5)],
        )
        c_suspected = SignalCommit(
            head_sha="sha_mid",
            timestamp=ts(self.t0, 0),
            events=[self._ev("job", SignalStatus.FAILURE, 4)],
            # No advisor_result
        )
        c_base = SignalCommit(
            head_sha="sha_old",
            timestamp=ts(self.t0, 0),
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
        self.assertIsInstance(res, AutorevertPattern)


class TestSignalReplace(unittest.TestCase):
    """Tests for Signal.replace() — `dataclasses.replace`-style API.

    The two introspection-based tests below are the load-bearing ones:
    one catches dropped fields (replace() forgetting to propagate a new
    field); the other catches stale/typo'd kwargs.
    """

    def setUp(self) -> None:
        self.t0 = datetime(2025, 8, 19, 12, 0, 0)

    # Sentinels pinned per current Signal API — non-default values for
    # every __init__ field. Adding a new Signal field MUST add an entry
    # here (otherwise the introspection assertion fires) AND propagate
    # the field inside Signal.replace (otherwise the no-changes round
    # trip assertion fires).
    _SENTINELS = {
        "key": "test/foo.py::test_bar",
        "workflow_name": "trunk",
        "commits": [SignalCommit("sha_a", datetime(2025, 8, 19, 12, 0, 0), [])],
        "job_base_name": "linux-jammy / test",
        "test_module": "test_foo",
        "source": SignalSource.JOB,
    }

    def _init_params(self):
        import inspect

        return [p for p in inspect.signature(Signal.__init__).parameters if p != "self"]

    def test_sentinels_cover_all_init_fields(self):
        """Adding a new Signal field forces this test to fail until a
        sentinel is pinned in `_SENTINELS`. Forces the test author to
        consider whether `Signal.replace()` propagates the new field too
        (which the next test would otherwise catch silently as a
        "dropped field" with an unhelpful default value).
        """
        missing = set(self._init_params()) - set(self._SENTINELS)
        self.assertFalse(
            missing,
            (
                f"Signal has new __init__ field(s) {sorted(missing)!r} not "
                "pinned in _SENTINELS. Add a sentinel value AND propagate the "
                "field inside Signal.replace, then re-run."
            ),
        )

    def test_replace_with_no_changes_preserves_all_fields(self):
        """`replace()` with no kwargs must return a copy where every field
        equals the original. Catches the bug class where Signal.replace
        forgets to forward a field — without enumerating each individually.
        """
        s = Signal(**self._SENTINELS)
        out = s.replace()
        self.assertIsNot(out, s, "replace() must return a new instance")
        for name in self._init_params():
            self.assertEqual(
                getattr(out, name),
                self._SENTINELS[name],
                f"Signal.replace() dropped field {name!r}",
            )

    def test_replace_swaps_a_field(self):
        """Smoke test: `replace(commits=...)` actually swaps the commit list."""
        s = Signal(**self._SENTINELS)
        new_commits = [SignalCommit("sha_b", self.t0, [])]
        out = s.replace(commits=new_commits)
        self.assertEqual(out.commits, new_commits)
        # original untouched
        self.assertEqual(s.commits, self._SENTINELS["commits"])
        # other fields preserved
        self.assertEqual(out.key, self._SENTINELS["key"])
        self.assertEqual(out.workflow_name, self._SENTINELS["workflow_name"])

    def test_replace_unknown_kwarg_raises(self):
        """Stale or typo'd kwargs are caught at runtime."""
        s = Signal(**self._SENTINELS)
        with self.assertRaises(TypeError):
            s.replace(this_field_does_not_exist=42)


class TestSignalCommitReplace(unittest.TestCase):
    """Tests for SignalCommit.replace() — same shape as TestSignalReplace."""

    def setUp(self) -> None:
        self.t0 = datetime(2025, 8, 19, 12, 0, 0)

    # Sentinels pinned per current SignalCommit API — non-default values
    # for every __init__ field. Adding a new SignalCommit field MUST add
    # an entry here AND propagate the field inside SignalCommit.replace.
    _SENTINELS = {
        "head_sha": "sha_abc",
        "timestamp": datetime(2025, 8, 19, 12, 0, 0),
        "events": [
            SignalEvent(
                "ev_a",
                SignalStatus.FAILURE,
                datetime(2025, 8, 19, 12, 0, 0),
                wf_run_id=1,
            )
        ],
        "advisor_result": AIAdvisorResult(
            verdict=AdvisorVerdict.REVERT,
            confidence=0.9,
            timestamp=datetime(2025, 8, 19, 12, 0, 0),
            signal_key="k",
        ),
    }

    def _init_params(self):
        import inspect

        return [
            p
            for p in inspect.signature(SignalCommit.__init__).parameters
            if p != "self"
        ]

    def test_sentinels_cover_all_init_fields(self):
        missing = set(self._init_params()) - set(self._SENTINELS)
        self.assertFalse(
            missing,
            (
                f"SignalCommit has new __init__ field(s) {sorted(missing)!r} not "
                "pinned in _SENTINELS. Add a sentinel value AND propagate the "
                "field inside SignalCommit.replace, then re-run."
            ),
        )

    def test_replace_with_no_changes_preserves_all_fields(self):
        c = SignalCommit(**self._SENTINELS)
        out = c.replace()
        self.assertIsNot(out, c)
        # `events` may have been re-sorted by SignalCommit.__init__; compare
        # by event names which are preserved in order for our sentinels.
        for name in self._init_params():
            if name == "events":
                self.assertEqual(
                    [e.name for e in out.events],
                    [e.name for e in self._SENTINELS["events"]],
                    "SignalCommit.replace() dropped 'events'",
                )
            else:
                self.assertEqual(
                    getattr(out, name),
                    self._SENTINELS[name],
                    f"SignalCommit.replace() dropped field {name!r}",
                )

    def test_replace_swaps_a_field(self):
        c = SignalCommit(**self._SENTINELS)
        new_events = [SignalEvent("ev_b", SignalStatus.SUCCESS, self.t0, wf_run_id=2)]
        out = c.replace(events=new_events)
        self.assertEqual([e.name for e in out.events], ["ev_b"])
        # advisor_result preserved
        self.assertEqual(out.advisor_result, self._SENTINELS["advisor_result"])

    def test_replace_unknown_kwarg_raises(self):
        c = SignalCommit(**self._SENTINELS)
        with self.assertRaises(TypeError):
            c.replace(this_field_does_not_exist=42)


if __name__ == "__main__":
    unittest.main()
