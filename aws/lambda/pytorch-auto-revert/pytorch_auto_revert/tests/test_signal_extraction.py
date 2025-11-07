import unittest
from datetime import datetime, timedelta
from typing import Iterable, List

from pytorch_auto_revert.signal import SignalStatus
from pytorch_auto_revert.signal_extraction import SignalExtractor
from pytorch_auto_revert.signal_extraction_datasource import SignalExtractionDatasource
from pytorch_auto_revert.signal_extraction_types import (
    JobBaseName,
    JobId,
    JobName,
    JobRow,
    RunAttempt,
    Sha,
    TestRow,
    WfRunId,
    WorkflowName,
)


def ts(base: datetime, minutes: int) -> datetime:
    return base + timedelta(minutes=minutes)


class FakeDatasource(SignalExtractionDatasource):
    """Test double for the datasource returning provided rows."""

    def __init__(self, jobs: List[JobRow], tests: List[TestRow]):
        self._jobs = jobs
        self._tests = tests

    def fetch_commits_in_time_range(
        self, *, repo_full_name: str, lookback_hours: int
    ) -> List[tuple[Sha, datetime]]:
        # Extract unique commits from jobs in the order they appear
        seen = set()
        commits = []
        for j in self._jobs:
            if j.head_sha not in seen:
                seen.add(j.head_sha)
                commits.append((j.head_sha, j.started_at))
        return commits

    def fetch_jobs_for_workflows(
        self,
        *,
        workflows: Iterable[str],
        lookback_hours: int,
        repo_full_name: str,
        head_shas: List[Sha],
    ) -> List[JobRow]:
        return list(self._jobs)

    def fetch_tests_for_job_ids(
        self,
        job_ids: List[JobId],
        *,
        failed_job_ids: List[JobId],
        lookback_hours: int = 24,
    ) -> List[TestRow]:
        ids = {int(j) for j in job_ids}
        return [r for r in self._tests if int(r.job_id) in ids]


def J(
    *,
    sha: str,
    wf: str = "trunk",
    run: int,
    job: int,
    attempt: int,
    name: str = "linux-test",
    status: str = "completed",
    conclusion: str = "success",
    started_at: datetime,
    rule: str = "",
):
    return JobRow(
        head_sha=Sha(sha),
        workflow_name=WorkflowName(wf),
        wf_run_id=WfRunId(run),
        job_id=JobId(job),
        run_attempt=RunAttempt(attempt),
        name=JobName(name),
        status=status,
        conclusion=conclusion,
        started_at=started_at,
        created_at=started_at,
        rule=rule,
    )


def T(
    *,
    job: int,
    run: int,
    attempt: int,
    file: str,
    name: str,
    failure_runs: int,
    success_runs: int = 0,
):
    return TestRow(
        job_id=JobId(job),
        wf_run_id=WfRunId(run),
        workflow_run_attempt=RunAttempt(attempt),
        file=file,
        classname="",
        name=name,
        failure_runs=failure_runs,
        success_runs=success_runs,
    )


class TestSignalExtraction(unittest.TestCase):
    def setUp(self) -> None:
        self.t0 = datetime(2025, 8, 20, 12, 0, 0)

    def _extract(self, jobs: List[JobRow], tests: List[TestRow]):
        se = SignalExtractor(workflows=["trunk"], lookback_hours=24)
        se._datasource = FakeDatasource(jobs, tests)
        return se.extract()

    def _find_job_signal(self, signals, wf: str, base: JobBaseName):
        for s in signals:
            if s.workflow_name == wf and s.key == base:
                return s
        return None

    def _find_test_signal(self, signals, wf: str, test_key: str):
        for s in signals:
            if s.workflow_name == wf and s.key == test_key:
                return s
        return None

    def test_commit_order_is_stable(self):
        # Two commits newer->older; include a failure so the job signal is emitted
        jobs = [
            J(
                sha="C2",
                run=200,
                job=1,
                attempt=1,
                started_at=ts(self.t0, 10),
                conclusion="failure",
                rule="infra",
            ),
            J(sha="C1", run=100, job=2, attempt=1, started_at=ts(self.t0, 5)),
        ]
        signals = self._extract(jobs, tests=[])
        base = jobs[0].base_name
        sig = self._find_job_signal(signals, "trunk", base)
        self.assertIsNotNone(sig)
        self.assertEqual([c.head_sha for c in sig.commits], ["C2", "C1"])

    def test_attempt_boundary_two_events_time_ordered(self):
        # One commit with attempt1(failure) then attempt2(success)
        jobs = [
            J(
                sha="C",
                run=300,
                job=10,
                attempt=1,
                started_at=ts(self.t0, 1),
                conclusion="failure",
            ),
            J(
                sha="C",
                run=300,
                job=11,
                attempt=2,
                started_at=ts(self.t0, 2),
                conclusion="success",
            ),
        ]
        signals = self._extract(jobs, tests=[])
        base = jobs[0].base_name
        sig = self._find_job_signal(signals, "trunk", base)
        self.assertIsNotNone(sig)
        self.assertEqual(len(sig.commits), 1)
        events = sig.commits[0].events
        self.assertEqual(len(events), 2)
        # time-ordered: failure then success
        self.assertEqual(events[0].status, SignalStatus.FAILURE)
        self.assertEqual(events[1].status, SignalStatus.SUCCESS)
        # carry attempt ids in names
        self.assertIn("attempt=1", events[0].name)
        self.assertIn("attempt=2", events[1].name)

    def test_keep_going_failure_test_track_failure_and_job_signal(self):
        # in_progress + KG-adjusted failure for a test-classified job
        jobs = [
            J(
                sha="K1",
                run=400,
                job=20,
                attempt=1,
                started_at=ts(self.t0, 3),
                status="in_progress",
                conclusion="failure",
                rule="pytest failure",
            )
        ]
        tests = [
            T(
                job=20,
                run=400,
                attempt=1,
                file="f.py",
                name="test_a",
                failure_runs=1,
                success_runs=0,
            )
        ]
        signals = self._extract(jobs, tests)
        # test signal present with FAILURE
        test_sig = self._find_test_signal(signals, "trunk", "f.py::test_a")
        self.assertIsNotNone(test_sig)
        self.assertEqual(test_sig.commits[0].events[0].status, SignalStatus.FAILURE)

    def test_cancelled_attempt_yields_no_event(self):
        # Include a separate failing commit so the job signal is emitted
        jobs = [
            J(
                sha="X2",
                run=501,
                job=31,
                attempt=1,
                started_at=ts(self.t0, 2),
                conclusion="failure",
                rule="infra",
            ),
            J(
                sha="X1",
                run=500,
                job=30,
                attempt=1,
                started_at=ts(self.t0, 1),
                status="completed",
                conclusion="cancelled",
            ),
        ]
        signals = self._extract(jobs, tests=[])
        base = jobs[0].base_name
        sig = self._find_job_signal(signals, "trunk", base)
        self.assertIsNotNone(sig)
        # find X1 commit in the signal and ensure it has no events
        x1 = next(c for c in sig.commits if c.head_sha == "X1")
        self.assertEqual(x1.events, [])

    def test_commits_without_jobs_are_included(self):
        # Verify that commits with no jobs at all are still included in signals
        # Simulate case where C2 has a failure, C3 has no jobs (e.g., periodic workflow),
        # and C1 has success
        jobs = [
            J(
                sha="C2",
                run=900,
                job=70,
                attempt=1,
                started_at=ts(self.t0, 10),
                conclusion="failure",
                rule="infra",
            ),
            J(
                sha="C1",
                run=910,
                job=71,
                attempt=1,
                started_at=ts(self.t0, 1),
                conclusion="success",
                rule="",
            ),
        ]

        # Create a fake datasource that returns an extra commit without jobs
        t0 = self.t0  # capture t0 for closure
        se = SignalExtractor(workflows=["trunk"], lookback_hours=24)

        class FakeDatasourceWithExtraCommit(FakeDatasource):
            def fetch_commits_in_time_range(
                self, *, repo_full_name: str, lookback_hours: int
            ):
                # Return commits C2, C3 (no jobs), C1 in newest->older order
                return [
                    (Sha("C2"), ts(t0, 10)),
                    (Sha("C3"), ts(t0, 5)),
                    (Sha("C1"), ts(t0, 1)),
                ]

        se._datasource = FakeDatasourceWithExtraCommit(jobs, [])
        signals = se.extract()

        base = jobs[0].base_name
        sig = self._find_job_signal(signals, "trunk", base)
        self.assertIsNotNone(sig)
        # Should have 3 commits: C2 (with events), C3 (no events), C1 (with events)
        self.assertEqual(len(sig.commits), 3)
        self.assertEqual([c.head_sha for c in sig.commits], ["C2", "C3", "C1"])
        # C2 should have failure event
        self.assertEqual(len(sig.commits[0].events), 1)
        self.assertEqual(sig.commits[0].events[0].status, SignalStatus.FAILURE)
        # C3 should have no events (commit without jobs)
        self.assertEqual(len(sig.commits[1].events), 0)
        # C1 should have success event
        self.assertEqual(len(sig.commits[2].events), 1)
        self.assertEqual(sig.commits[2].events[0].status, SignalStatus.SUCCESS)

    def test_test_track_mapping_failure_then_success(self):
        # Same test fails on newer commit and passes on older commit
        jobs = [
            J(
                sha="N2",
                run=800,
                job=60,
                attempt=1,
                started_at=ts(self.t0, 11),
                conclusion="failure",
                rule="pytest failure",
            ),
            J(
                sha="N1",
                run=810,
                job=61,
                attempt=1,
                started_at=ts(self.t0, 1),
                conclusion="success",
                rule="",
            ),
        ]
        tests = [
            T(
                job=60,
                run=800,
                attempt=1,
                file="g.py",
                name="test_y",
                failure_runs=1,
                success_runs=0,
            ),
            T(
                job=61,
                run=810,
                attempt=1,
                file="g.py",
                name="test_y",
                failure_runs=0,
                success_runs=1,
            ),
        ]
        signals = self._extract(jobs, tests)
        test_sig = self._find_test_signal(signals, "trunk", "g.py::test_y")
        self.assertIsNotNone(test_sig)
        # order newest -> older
        self.assertEqual([c.head_sha for c in test_sig.commits], ["N2", "N1"])
        # newer failure, older success
        self.assertEqual(test_sig.commits[0].events[0].status, SignalStatus.FAILURE)
        self.assertEqual(test_sig.commits[1].events[0].status, SignalStatus.SUCCESS)

    def test_inject_pending_workflow_event_when_missing_in_signal(self):
        # Multi-stage workflow: newest commit has a pending workflow run (build stage),
        # tests not yet scheduled -> no events for that wf_run_id in the test signal.
        # Older commit has a test failure so the test signal exists.
        jobs = [
            # Newest commit: pending build job under wf_run_id=200
            J(
                sha="H2",
                wf="trunk",
                run=200,
                job=901,
                attempt=1,
                name="linux-build",
                status="in_progress",
                conclusion="",
                started_at=ts(self.t0, 20),
            ),
            # Older commit: test job that failed with a concrete test verdict
            J(
                sha="H1",
                wf="trunk",
                run=190,
                job=902,
                attempt=1,
                name="linux-test",
                status="completed",
                conclusion="failure",
                started_at=ts(self.t0, 10),
                rule="pytest failure",
            ),
        ]
        tests = [
            T(
                job=902,
                run=190,
                attempt=1,
                file="m.py",
                name="test_synthetic_pending",
                failure_runs=1,
                success_runs=0,
            )
        ]

        signals = self._extract(jobs, tests)
        test_sig = self._find_test_signal(
            signals, "trunk", "m.py::test_synthetic_pending"
        )
        self.assertIsNotNone(test_sig)
        # Expect two commits in newest->older order
        self.assertEqual([c.head_sha for c in test_sig.commits], ["H2", "H1"])

        # For the newest commit (H2): we should have a synthetic pending event for wf_run_id=200
        c_new = test_sig.commits[0]
        self.assertEqual(len(c_new.events), 1)
        self.assertEqual(c_new.events[0].status, SignalStatus.PENDING)
        self.assertEqual(c_new.events[0].wf_run_id, 200)

    def test_test_track_combines_shards_failure_wins(self):
        # Same commit/run/attempt/test_id present on two shards of the same base:
        # - shard A reports success
        # - shard B reports failure
        # When combining, the attempt should reflect a FAILURE event (and we still
        # retain SUCCESS if it was also observed).
        base_name = "linux-test (dynamo_wrapped, 1, 3)"  # numeric tokens may be ignored/merged by base logic

        jobs = [
            # Both jobs share the same commit, workflow run, attempt and base name
            J(
                sha="C",
                run=5000,
                job=1001,
                attempt=1,
                name=base_name,
                started_at=ts(self.t0, 10),
                conclusion="failure",
                rule="pytest failure",  # marks base as test-track candidate
            ),
            J(
                sha="C",
                run=5000,
                job=1002,
                attempt=1,
                name=base_name,
                started_at=ts(self.t0, 12),
                conclusion="success",
                rule="",
            ),
        ]

        tests = [
            # Same test id across two shards: one success and one failure
            T(
                job=1001,
                run=5000,
                attempt=1,
                file="h.py",
                name="test_merge",
                failure_runs=1,
                success_runs=0,
            ),
            T(
                job=1002,
                run=5000,
                attempt=1,
                file="h.py",
                name="test_merge",
                failure_runs=0,
                success_runs=1,
            ),
        ]

        signals = self._extract(jobs, tests)
        test_sig = self._find_test_signal(signals, "trunk", "h.py::test_merge")
        self.assertIsNotNone(test_sig)
        # Single commit present
        self.assertEqual([c.head_sha for c in test_sig.commits], ["C"])
        events = test_sig.commits[0].events
        # Expect exactly one FAILURE event for the attempt (failure dominates)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].status, SignalStatus.FAILURE)

    def test_test_track_combines_shards_success_single_event(self):
        # Two shards for the same test attempt both succeed; ensure we emit
        # a single SUCCESS event for that attempt (no duplication).
        base_name = "linux-test (dynamo_wrapped, 1, 3)"

        jobs = [
            # Mark base as test-track by using a test failure classification on one job
            # (selection signal only). Actual test rows are successes.
            J(
                sha="C2",
                run=6000,
                job=1101,
                attempt=1,
                name=base_name,
                started_at=ts(self.t0, 10),
                conclusion="failure",
                rule="pytest failure",
            ),
            J(
                sha="C2",
                run=6000,
                job=1102,
                attempt=1,
                name=base_name,
                started_at=ts(self.t0, 12),
                conclusion="success",
                rule="",
            ),
            # Older commit with the same test failing at least once so the test id is included
            J(
                sha="C1",
                run=5990,
                job=1103,
                attempt=1,
                name=base_name,
                started_at=ts(self.t0, 1),
                conclusion="failure",
                rule="pytest failure",
            ),
        ]

        tests = [
            # Both shards report success for the same test id
            T(
                job=1101,
                run=6000,
                attempt=1,
                file="h2.py",
                name="test_merge_success",
                failure_runs=0,
                success_runs=1,
            ),
            T(
                job=1102,
                run=6000,
                attempt=1,
                file="h2.py",
                name="test_merge_success",
                failure_runs=0,
                success_runs=1,
            ),
            # Older commit has a failure for the same test id to ensure inclusion
            T(
                job=1103,
                run=5990,
                attempt=1,
                file="h2.py",
                name="test_merge_success",
                failure_runs=1,
                success_runs=0,
            ),
        ]

        signals = self._extract(jobs, tests)
        test_sig = self._find_test_signal(signals, "trunk", "h2.py::test_merge_success")
        self.assertIsNotNone(test_sig)
        # Should contain both commits, newest first
        self.assertEqual([c.head_sha for c in test_sig.commits], ["C2", "C1"])
        # Find C2 and verify only a single SUCCESS event is emitted for the attempt
        c2 = test_sig.commits[0]
        events = c2.events
        # Expect exactly one SUCCESS event for the attempt
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].status, SignalStatus.SUCCESS)


if __name__ == "__main__":
    unittest.main()
