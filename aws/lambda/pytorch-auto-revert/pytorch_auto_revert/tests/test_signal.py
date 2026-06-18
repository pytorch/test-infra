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
    """Tests for Signal.replace() — `dataclasses.replace`-style API."""

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
        "test_file": "test/foo.py",
        "test_classname": "TestFooBar",
        "test_name": "test_bar",
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
        with self.assertRaisesRegex(TypeError, "this_field_does_not_exist"):
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
        "job_group_concluded": True,
        "has_dispatch_run": True,
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
        with self.assertRaisesRegex(TypeError, "this_field_does_not_exist"):
            c.replace(this_field_does_not_exist=42)


class TestBornRedTestSignal(unittest.TestCase):
    """Test-track born-red detection (order-independent set predicate).

    Covers the blind spot where a test is introduced — or enabled / un-skipped
    / renamed — already broken: the green→red partition path returns
    `Ineligible(NO_SUCCESSES)` and bails before dispatching the advisor.

    The detector ignores commit ordering and pending commits. It fires when the
    signal has no successes, ≥1 failing commit, and ≥1 *concluded baseline*
    commit (`job_group_concluded and not events`) OLDER than the suspect (the
    oldest failure), provided no unconcluded/pending commit sits in the
    introduction gap. Real trunk signals always carry a pending head and empty
    commits interleaved among the failures, both of which the earlier strict
    `[FAIL...][EMPTY...]` shape rejected — so it never fired in practice.
    """

    def setUp(self) -> None:
        self.t0 = datetime(2026, 5, 21, 12, 0, 0)

    def _ev(
        self,
        name: str,
        status: SignalStatus,
        minute: int,
        wf_run_id: int = 1,
        job_id: int = 100,
    ) -> SignalEvent:
        return SignalEvent(
            name=name,
            status=status,
            started_at=ts(self.t0, minute),
            wf_run_id=wf_run_id,
            job_id=job_id,
        )

    def _fail(self, sha: str, minute: int, *, job_id: int = 100) -> SignalCommit:
        # A failing commit whose job group concluded.
        return SignalCommit(
            head_sha=sha,
            timestamp=ts(self.t0, minute),
            events=[self._ev("t", SignalStatus.FAILURE, minute, job_id=job_id)],
            job_group_concluded=True,
        )

    def _baseline(self, sha: str, minute: int) -> SignalCommit:
        # Job group concluded, no event for this test → born-red baseline
        # witness (the test was genuinely absent on this commit).
        return SignalCommit(
            head_sha=sha,
            timestamp=ts(self.t0, minute),
            events=[],
            job_group_concluded=True,
        )

    def _pending(self, sha: str, minute: int) -> SignalCommit:
        # Job group still running → carries a PENDING event, not concluded.
        return SignalCommit(
            head_sha=sha,
            timestamp=ts(self.t0, minute),
            events=[self._ev("t", SignalStatus.PENDING, minute)],
            job_group_concluded=False,
        )

    def _unrun(self, sha: str, minute: int) -> SignalCommit:
        # No jobs concluded for this group yet → empty AND not concluded. Not a
        # baseline witness: we cannot tell whether the test exists here.
        return SignalCommit(
            head_sha=sha,
            timestamp=ts(self.t0, minute),
            events=[],
            job_group_concluded=False,
        )

    def _dispatched(self, sha: str, minute: int) -> SignalCommit:
        # Already restarted once via workflow_dispatch, concluded with no event
        # for this test (test absent / filtered out). Not a baseline (the
        # dispatch can't prove absence), but must NOT be restarted again.
        return SignalCommit(
            head_sha=sha,
            timestamp=ts(self.t0, minute),
            events=[],
            job_group_concluded=False,
            has_dispatch_run=True,
        )

    def _test_signal(self, commits, key: str = "f.py::t") -> Signal:
        return Signal(
            key=key,
            workflow_name="trunk",
            commits=commits,
            source=SignalSource.TEST,
        )

    # ---- partition_born_red predicate ----

    def test_partition_born_red_canonical_shape(self):
        commits = [
            self._fail("f1", 0, job_id=1),
            self._fail("f2", -10, job_id=2),
            self._baseline("e1", -20),
            self._baseline("e2", -30),
        ]
        part = self._test_signal(commits).partition_born_red()
        self.assertIsNotNone(part)
        assert part is not None  # narrow type for mypy
        self.assertEqual([c.head_sha for c in part.failed], ["f1", "f2"])
        # Scope stops at the most-recent baseline (e1); e2 is out of scope.
        self.assertEqual([c.head_sha for c in part.successful], ["e1"])
        self.assertEqual(part.unknown, [])

    def test_partition_born_red_fires_despite_leading_pending(self):
        # The newest commits are still running (pending head) — the common
        # real-world case. Pending commits are ignored; the predicate still
        # fires on the failures + concluded baseline below them.
        commits = [
            self._pending("p1", 10),
            self._pending("p2", 5),
            self._fail("f1", 0),
            self._fail("f2", -10),
            self._baseline("e1", -20),
        ]
        part = self._test_signal(commits).partition_born_red()
        self.assertIsNotNone(part)
        assert part is not None
        self.assertEqual([c.head_sha for c in part.failed], ["f1", "f2"])
        self.assertEqual([c.head_sha for c in part.successful], ["e1"])

    def test_partition_born_red_scoped_to_most_recent_baseline(self):
        # A concluded baseline (g1) sits between two failures: it proves the
        # test was absent there, i.e. the older failure (f_old) belongs to a
        # *prior* episode that already recovered. Scope is the most-recent
        # baseline (g1) and newer, so only the newer failures fire on it.
        commits = [
            self._fail("f1", 0),
            self._fail("f2", -5),
            self._baseline("g1", -10),  # most-recent baseline → scope boundary
            self._fail("f_old", -15),  # pre-recovery failure, out of scope
            self._baseline("e1", -20),
        ]
        part = self._test_signal(commits).partition_born_red()
        self.assertIsNotNone(part)
        assert part is not None
        self.assertEqual([c.head_sha for c in part.failed], ["f1", "f2"])
        self.assertEqual(part.failed[-1].head_sha, "f2")  # suspect = oldest in scope
        self.assertEqual([c.head_sha for c in part.successful], ["g1"])

    def test_partition_born_red_none_when_recovered_at_head(self):
        # A concluded baseline NEWER than the failures (the test was removed /
        # disabled again) → recovered. Scope = [C] only, holds no failure → None.
        commits = [
            self._baseline("c_head", 0),  # most-recent baseline, newer than fails
            self._fail("f1", -10),
            self._fail("f2", -20),
            self._baseline("e1", -30),
        ]
        self.assertIsNone(self._test_signal(commits).partition_born_red())

    def test_partition_born_red_fires_with_unrun_in_introduction_gap(self):
        # An unrun (no jobs, no events) commit sits between the suspect and the
        # nearest older baseline. We do NOT defer the suspect decision: dispatch
        # on the oldest OBSERVED failure (f2). The unrun commit lands in
        # `unknown` so the caller can restart it to find the true introducer.
        commits = [
            self._fail("f1", 0),
            self._fail("f2", -10),
            self._unrun("u1", -15),  # unrun gap commit → restart candidate
            self._baseline("e1", -20),
        ]
        part = self._test_signal(commits).partition_born_red()
        self.assertIsNotNone(part)
        assert part is not None
        self.assertEqual([c.head_sha for c in part.failed], ["f1", "f2"])
        self.assertEqual(part.failed[-1].head_sha, "f2")  # suspect = oldest fail
        self.assertEqual([c.head_sha for c in part.successful], ["e1"])
        # Introduction gap = the unrun commit between suspect and baseline.
        self.assertEqual([c.head_sha for c in part.unknown], ["u1"])

    def test_partition_born_red_fires_with_pending_head_and_gap(self):
        # Full real-world shape (newest→oldest): a pending head, two failures,
        # pending commits in the introduction gap, then concluded baselines
        # with another pending interleaved among them:
        #     P P P F F P P P C P C
        # Born-red fires on the oldest observed failure (f4); every pending is
        # ignored regardless of position.
        commits = [
            self._pending("p0", 100),
            self._pending("p1", 90),
            self._pending("p2", 80),
            self._fail("f3", 70, job_id=13),
            self._fail("f4", 60, job_id=14),
            self._pending("p5", 50),
            self._pending("p6", 40),
            self._pending("p7", 30),
            self._baseline("c8", 20),
            self._pending("p9", 10),
            self._baseline("c10", 0),
        ]
        part = self._test_signal(commits).partition_born_red()
        self.assertIsNotNone(part)
        assert part is not None
        self.assertEqual([c.head_sha for c in part.failed], ["f3", "f4"])
        self.assertEqual(part.failed[-1].head_sha, "f4")  # suspect = oldest fail
        # Baseline = the most-recent concluded-empty (c8); c10 is out of scope.
        self.assertEqual([c.head_sha for c in part.successful], ["c8"])
        # Introduction gap = commits strictly between suspect (f4) and the
        # baseline (c8): the pending p5/p6/p7. They are covered separators
        # (have events), so they trigger no restart — see the process-level
        # test below.
        self.assertEqual([c.head_sha for c in part.unknown], ["p5", "p6", "p7"])

    def test_partition_born_red_none_without_concluded_baseline(self):
        # The only empty commits are unconcluded (jobs not finished) → no proof
        # the test was ever absent → not born-red.
        commits = [self._fail("f1", 0), self._fail("f2", -10), self._unrun("u1", -20)]
        self.assertIsNone(self._test_signal(commits).partition_born_red())

    def test_partition_born_red_none_when_has_successes(self):
        # Any success disqualifies born-red — the main partition path applies.
        commits = [
            self._fail("f1", 0),
            SignalCommit(
                head_sha="s1",
                timestamp=ts(self.t0, -10),
                events=[self._ev("t", SignalStatus.SUCCESS, -10)],
                job_group_concluded=True,
            ),
            self._baseline("e1", -20),
        ]
        self.assertIsNone(self._test_signal(commits).partition_born_red())

    def test_partition_born_red_none_chronic_failure_no_baseline(self):
        # All commits fail, no concluded-empty baseline — chronic shape.
        commits = [self._fail("f1", 0), self._fail("f2", -10), self._fail("f3", -20)]
        self.assertIsNone(self._test_signal(commits).partition_born_red())

    def test_partition_born_red_none_without_failures(self):
        # Only baseline commits — nothing to act on.
        commits = [self._baseline("e1", 0), self._baseline("e2", -10)]
        self.assertIsNone(self._test_signal(commits).partition_born_red())

    def test_partition_born_red_none_single_failure_no_baseline(self):
        # Single failing commit with no baseline below it.
        self.assertIsNone(self._test_signal([self._fail("f1", 0)]).partition_born_red())

    # ---- process_valid_autorevert_pattern wiring ----

    def test_process_dispatches_advisor_for_born_red(self):
        commits = [
            self._fail("f1", 0, job_id=11),
            self._fail("f2", -10, job_id=12),
            self._baseline("e1", -20),
        ]
        res = self._test_signal(commits).process_valid_autorevert_pattern()
        self.assertIsInstance(res, Ineligible)
        self.assertEqual(res.reason, IneligibleReason.NO_SUCCESSES)
        self.assertIsNotNone(res.advisor)
        # Suspect = oldest failing commit (f2)
        self.assertEqual(res.advisor.suspect_commit, "f2")
        self.assertEqual(res.advisor.failed_commits, ("f1", "f2"))
        self.assertEqual(res.advisor.successful_commits, ("e1",))
        self.assertTrue(res.advisor.is_born_red)

    def test_process_dispatches_on_real_flip_shape(self):
        # Regression for the real-world shape that the old strict partition
        # never fired on: pending head + a failure + an interleaved *pending*
        # commit (jobs not finished yet) + another failure + concluded baseline
        # tail. (Mirrors inductor flip_zero_dim_dynamic_shapes_cuda, 2026-05-21.)
        commits = [
            self._pending("p1", 30),
            self._pending("p2", 25),
            self._fail("f1", 20, job_id=11),
            self._pending("g1", 15),  # interleaved pending (not yet finished)
            self._fail("f2", 10, job_id=12),
            self._baseline("e1", 0),
            self._baseline("e2", -10),
        ]
        res = self._test_signal(commits).process_valid_autorevert_pattern()
        self.assertIsInstance(res, Ineligible)
        self.assertEqual(res.reason, IneligibleReason.NO_SUCCESSES)
        self.assertIsNotNone(res.advisor)
        self.assertTrue(res.advisor.is_born_red)
        # Suspect = oldest failure (f2); both failures reported.
        self.assertEqual(res.advisor.suspect_commit, "f2")
        self.assertEqual(res.advisor.failed_commits, ("f1", "f2"))
        # Baseline = the most-recent concluded-empty (e1); e2 is out of scope.
        self.assertEqual(res.advisor.successful_commits, ("e1",))

    def test_process_holds_advisor_below_failing_commit_threshold(self):
        # Single failing commit — wait for the next trunk advance before paying
        # advisor cost (REQUIRE_FAILED_COMMITS_BORN_RED == 2). Distinct
        # commits, not raw event counts, gate the dispatch.
        commits = [self._fail("f1", 0), self._baseline("e1", -10)]
        res = self._test_signal(commits).process_valid_autorevert_pattern()
        self.assertIsInstance(res, Ineligible)
        self.assertEqual(res.reason, IneligibleReason.NO_SUCCESSES)
        self.assertIsNone(res.advisor)

    def test_process_threshold_counts_distinct_commits_not_events(self):
        # Single commit with multiple FAILURE events (e.g. retries / multiple
        # shards) is one trunk observation, NOT two — should not dispatch.
        c_multi_event = SignalCommit(
            head_sha="f1",
            timestamp=ts(self.t0, 0),
            events=[
                self._ev("t", SignalStatus.FAILURE, 0, wf_run_id=1, job_id=11),
                self._ev("t", SignalStatus.FAILURE, 1, wf_run_id=2, job_id=12),
                self._ev("t", SignalStatus.FAILURE, 2, wf_run_id=3, job_id=13),
            ],
            job_group_concluded=True,
        )
        commits = [c_multi_event, self._baseline("e1", -10)]
        res = self._test_signal(commits).process_valid_autorevert_pattern()
        self.assertIsInstance(res, Ineligible)
        self.assertEqual(res.reason, IneligibleReason.NO_SUCCESSES)
        self.assertIsNone(res.advisor)

    def test_process_restarts_unrun_gap_and_dispatches_advisor_in_parallel(self):
        # ≥2 failures + an unrun (no jobs, no events) commit in the introduction
        # gap → restart the unrun commit to bisect AND dispatch the advisor on
        # the oldest observed failure in the same tick (Option A).
        commits = [
            self._fail("f1", 0, job_id=11),
            self._fail("f2", -10, job_id=12),
            self._unrun("u1", -15),  # ghstack stack-middle: never scheduled
            self._baseline("e1", -20),
        ]
        res = self._test_signal(commits).process_valid_autorevert_pattern()
        self.assertIsInstance(res, RestartCommits)
        assert isinstance(res, RestartCommits)
        self.assertIn("u1", res.commit_shas)
        # Advisor fires in parallel, on the oldest observed failure.
        self.assertIsNotNone(res.advisor)
        assert res.advisor is not None
        self.assertEqual(res.advisor.suspect_commit, "f2")
        self.assertTrue(res.advisor.is_born_red)

    def test_process_ghstack_restarts_gap_below_single_failure(self):
        # The motivating case: a ghstack of commits lands and introduces a
        # broken test; `push` only runs jobs for the stack head, so the
        # stack-middles are unrun. Only the head has failed so far (< 2
        # observed failures → no advisor yet), but we still restart the unrun
        # middles to gather the coverage needed to pinpoint the introducer.
        commits = [
            self._fail("head", 0, job_id=11),
            self._unrun("mid1", -10),
            self._unrun("mid2", -20),
            self._baseline("base", -30),
        ]
        res = self._test_signal(commits).process_valid_autorevert_pattern()
        self.assertIsInstance(res, RestartCommits)
        assert isinstance(res, RestartCommits)
        self.assertEqual(res.commit_shas, {"mid1", "mid2"})
        # No advisor: only one observed failure so far.
        self.assertIsNone(res.advisor)

    def test_process_pending_gap_no_restart_dispatches_advisor(self):
        # A *pending* (jobs running) commit in the gap is a covered separator,
        # not a restart candidate — it resolves on its own. No restart; the
        # advisor dispatches on the oldest observed failure.
        commits = [
            self._fail("f1", 0, job_id=11),
            self._fail("f2", -10, job_id=12),
            self._pending("p1", -15),  # jobs running — covered separator
            self._baseline("e1", -20),
        ]
        res = self._test_signal(commits).process_valid_autorevert_pattern()
        self.assertIsInstance(res, Ineligible)
        self.assertEqual(res.reason, IneligibleReason.NO_SUCCESSES)
        self.assertIsNotNone(res.advisor)
        self.assertEqual(res.advisor.suspect_commit, "f2")

    def test_process_restart_respects_bisection_limit(self):
        # Three unrun commits in the gap, bisection_limit=1 → only the bisection
        # midpoint is scheduled (the same hybrid planner the green→red path uses).
        commits = [
            self._fail("f1", 0, job_id=11),
            self._fail("f2", -10, job_id=12),
            self._unrun("u1", -15),
            self._unrun("u2", -20),
            self._unrun("u3", -25),
            self._baseline("e1", -30),
        ]
        res = self._test_signal(commits).process_valid_autorevert_pattern(
            bisection_limit=1
        )
        self.assertIsInstance(res, RestartCommits)
        assert isinstance(res, RestartCommits)
        self.assertEqual(len(res.commit_shas), 1)
        self.assertTrue(res.commit_shas <= {"u1", "u2", "u3"})

    def test_process_mixed_pending_and_unrun_gap_restarts_only_unrun(self):
        # Gap holds one pending (covered separator) and one unrun (candidate).
        # Only the unrun commit is restarted; the pending resolves on its own.
        commits = [
            self._fail("f1", 0, job_id=11),
            self._fail("f2", -10, job_id=12),
            self._pending("p1", -13),  # jobs running — separator, no restart
            self._unrun("u1", -16),  # no jobs — restart candidate
            self._baseline("e1", -20),
        ]
        res = self._test_signal(commits).process_valid_autorevert_pattern()
        self.assertIsInstance(res, RestartCommits)
        assert isinstance(res, RestartCommits)
        self.assertEqual(res.commit_shas, {"u1"})

    def test_process_block_verdict_keeps_covering_uncovered_gap(self):
        # A not_related verdict on the current suspect, but an unrun commit is
        # still uncovered in the gap → keep restarting it (the real introducer
        # may be there) rather than surfacing the block. No fresh advisor.
        verdict = AIAdvisorResult(
            verdict=AdvisorVerdict.NOT_RELATED,
            confidence=0.95,
            timestamp=self.t0,
            signal_key="f.py::t",
        )
        suspect = SignalCommit(
            head_sha="f2",
            timestamp=ts(self.t0, -10),
            events=[self._ev("t", SignalStatus.FAILURE, -10, job_id=12)],
            advisor_result=verdict,
            job_group_concluded=True,
        )
        commits = [
            self._fail("f1", 0, job_id=11),
            suspect,
            self._unrun("u1", -15),
            self._baseline("e1", -20),
        ]
        res = self._test_signal(commits).process_valid_autorevert_pattern()
        self.assertIsInstance(res, RestartCommits)
        assert isinstance(res, RestartCommits)
        self.assertEqual(res.commit_shas, {"u1"})
        self.assertIsNone(res.advisor)  # suspect ruled out — no re-dispatch

    def test_process_revert_verdict_acts_even_with_uncovered_gap(self):
        # Option-A tradeoff, made explicit: a confident revert verdict on the
        # oldest observed failure is acted on immediately, even though an unrun
        # gap commit below it has not concluded. Bounded by the advisor's
        # diff-introduction semantics + the confidence gate.
        verdict = AIAdvisorResult(
            verdict=AdvisorVerdict.REVERT,
            confidence=0.95,
            timestamp=self.t0,
            signal_key="f.py::t",
        )
        suspect = SignalCommit(
            head_sha="f2",
            timestamp=ts(self.t0, -10),
            events=[self._ev("t", SignalStatus.FAILURE, -10, job_id=12)],
            advisor_result=verdict,
            job_group_concluded=True,
        )
        commits = [
            self._fail("f1", 0, job_id=11),
            suspect,
            self._unrun("u1", -15),
            self._baseline("e1", -20),
        ]
        res = self._test_signal(commits).process_valid_autorevert_pattern()
        self.assertIsInstance(res, AutorevertPattern)
        assert isinstance(res, AutorevertPattern)
        self.assertEqual(res.suspected_commit, "f2")

    def test_process_does_not_redispatch_already_dispatched_gap_commit(self):
        # The whole point of has_dispatch_run: a gap commit we already restarted
        # once (workflow_dispatch concluded, test still absent → no event) is a
        # covered separator. Only the not-yet-probed unrun commit is restarted —
        # no second dispatch on the same commit.
        commits = [
            self._fail("f1", 0, job_id=11),
            self._fail("f2", -10, job_id=12),
            self._dispatched("d1", -15),  # already restarted once → don't repeat
            self._unrun("u1", -18),  # never probed → restart this one
            self._baseline("e1", -25),
        ]
        res = self._test_signal(commits).process_valid_autorevert_pattern()
        self.assertIsInstance(res, RestartCommits)
        assert isinstance(res, RestartCommits)
        self.assertEqual(res.commit_shas, {"u1"})

    def test_process_all_gap_commits_dispatched_no_restart(self):
        # Once every gap commit has been probed once, there is nothing left to
        # restart — the advisor still dispatches on the oldest observed failure.
        commits = [
            self._fail("f1", 0, job_id=11),
            self._fail("f2", -10, job_id=12),
            self._dispatched("d1", -15),
            self._dispatched("d2", -18),
            self._baseline("e1", -25),
        ]
        res = self._test_signal(commits).process_valid_autorevert_pattern()
        self.assertIsInstance(res, Ineligible)
        self.assertEqual(res.reason, IneligibleReason.NO_SUCCESSES)
        self.assertIsNotNone(res.advisor)
        self.assertEqual(res.advisor.suspect_commit, "f2")

    def test_process_no_advisor_for_job_track_born_red(self):
        # Born-red detection is test-track only. Job-track signals with the
        # same shape are likely persistent infra failures or new jobs with a
        # warm-up — not actionable via this path.
        commits = [
            self._fail("f1", 0, job_id=21),
            self._fail("f2", -10, job_id=22),
            self._baseline("e1", -20),
        ]
        s = Signal(
            key="job",
            workflow_name="trunk",
            commits=commits,
            source=SignalSource.JOB,
        )
        res = s.process_valid_autorevert_pattern()
        self.assertIsInstance(res, Ineligible)
        self.assertEqual(res.reason, IneligibleReason.NO_SUCCESSES)
        self.assertIsNone(res.advisor)

    def test_process_no_advisor_when_chronic_failure_no_baseline(self):
        # Chronic shape — every commit fails, no concluded-empty baseline.
        # Lambda continues to return the existing NO_SUCCESSES without advisor.
        commits = [self._fail("f1", 0), self._fail("f2", -10), self._fail("f3", -20)]
        res = self._test_signal(commits).process_valid_autorevert_pattern()
        self.assertIsInstance(res, Ineligible)
        self.assertEqual(res.reason, IneligibleReason.NO_SUCCESSES)
        self.assertIsNone(res.advisor)

    def test_process_returns_autorevert_pattern_on_advisor_revert_verdict(self):
        # Advisor previously returned `revert` on the suspect with high
        # confidence → born-red path lifts the verdict into an
        # `AutorevertPattern` so the lambda actions a revert.
        verdict = AIAdvisorResult(
            verdict=AdvisorVerdict.REVERT,
            confidence=0.95,
            timestamp=self.t0,
            signal_key="f.py::t",
        )
        suspect = SignalCommit(
            head_sha="f2",
            timestamp=ts(self.t0, -10),
            events=[self._ev("t", SignalStatus.FAILURE, -10, job_id=12)],
            advisor_result=verdict,
            job_group_concluded=True,
        )
        commits = [self._fail("f1", 0, job_id=11), suspect, self._baseline("e1", -20)]
        res = self._test_signal(commits).process_valid_autorevert_pattern()
        self.assertIsInstance(res, AutorevertPattern)
        self.assertEqual(res.suspected_commit, "f2")
        # Newer failing commit reported alongside the suspect.
        self.assertEqual(res.newer_failing_commits, ["f1"])
        # Older "successful" reference = newest baseline commit (implicit
        # baseline) — used in the revert PR body.
        self.assertEqual(res.older_successful_commit, "e1")
        self.assertIsNotNone(res.advisor_verdict)

    def test_process_blocks_on_advisor_not_related_verdict(self):
        verdict = AIAdvisorResult(
            verdict=AdvisorVerdict.NOT_RELATED,
            confidence=0.95,
            timestamp=self.t0,
            signal_key="f.py::t",
        )
        suspect = SignalCommit(
            head_sha="f2",
            timestamp=ts(self.t0, -10),
            events=[self._ev("t", SignalStatus.FAILURE, -10, job_id=12)],
            advisor_result=verdict,
            job_group_concluded=True,
        )
        commits = [self._fail("f1", 0, job_id=11), suspect, self._baseline("e1", -20)]
        res = self._test_signal(commits).process_valid_autorevert_pattern()
        self.assertIsInstance(res, Ineligible)
        self.assertEqual(res.reason, IneligibleReason.ADVISOR_NOT_RELATED)


if __name__ == "__main__":
    unittest.main()
