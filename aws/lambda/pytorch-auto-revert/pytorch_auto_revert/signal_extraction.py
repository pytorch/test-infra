from __future__ import annotations


"""
Signal extraction layer.

Transforms raw workflow/job/test data into Signal objects used by signal.py.
"""

from dataclasses import dataclass
from datetime import datetime
from typing import Dict, Iterable, List, Optional, Set, Tuple

from .job_agg_index import JobAggIndex, JobMeta, SignalStatus as AggStatus
from .signal import Signal, SignalCommit, SignalEvent, SignalStatus
from .signal_extraction_datasource import SignalExtractionDatasource
from .signal_extraction_types import (
    JobBaseName,
    JobId,
    JobRow,
    RunAttempt,
    Sha,
    TestId,
    TestRow,
    WfRunId,
    WorkflowName,
)


@dataclass(frozen=True)
class TestOutcome:
    failing: bool
    errored: bool
    started_at: datetime


class SignalExtractor:
    def __init__(
        self,
        workflows: Iterable[str],
        lookback_hours: int = 24,
        repo_full_name: str = "pytorch/pytorch",
    ) -> None:
        self.workflows = list(workflows)
        self.lookback_hours = lookback_hours
        self.repo_full_name = repo_full_name
        # Datasource for DB access
        self._datasource = SignalExtractionDatasource()

    def _fmt_event_name(
        self,
        *,
        workflow: str,
        kind: str,
        identifier: str,
        wf_run_id: WfRunId,
        run_attempt: RunAttempt,
    ) -> str:
        """Consistent, debuggable event name for SignalEvent."""
        return f"wf={workflow} kind={kind} id={identifier} run={wf_run_id} attempt={run_attempt}"

    # -----------------------------
    # Public API
    # -----------------------------
    def extract(self) -> List[Signal]:
        """Extract Signals for configured workflows within the lookback window."""
        # Fetch commits first to ensure we include commits without jobs
        commits = self._datasource.fetch_commits_in_time_range(
            repo_full_name=self.repo_full_name,
            lookback_hours=self.lookback_hours,
        )

        # Extract just the ordered list of shas
        commit_shas = [sha for sha, _ in commits]

        # Fetch jobs for these commits
        jobs = self._datasource.fetch_jobs_for_workflows(
            repo_full_name=self.repo_full_name,
            workflows=self.workflows,
            lookback_hours=self.lookback_hours,
            head_shas=commit_shas,
        )

        # Select jobs to participate in test-track details fetch
        test_track_job_ids, failed_job_ids = self._select_test_track_job_ids(jobs)
        test_rows = self._datasource.fetch_tests_for_job_ids(
            test_track_job_ids, failed_job_ids=failed_job_ids
        )

        test_signals = self._build_test_signals(jobs, test_rows, commit_shas)
        job_signals = self._build_non_test_signals(jobs, commit_shas)
        # Deduplicate events within commits across all signals as a final step
        # GitHub-specific behavior like "rerun failed" can reuse job instances for reruns.
        # When that happens, the jobs have identical timestamps by DIFFERENT job ids.
        # But since they are still the same job logically, we want to deduplicate them
        # for the purposes of signal events.
        return self._dedup_signal_events(test_signals + job_signals)

    # -----------------------------
    # Deduplication (GitHub-specific)
    # -----------------------------
    def _dedup_signal_events(self, signals: List[Signal]) -> List[Signal]:
        deduped: List[Signal] = []
        for s in signals:
            new_commits: List[SignalCommit] = []
            for c in s.commits:
                filtered: List[SignalEvent] = []
                prev_key: Optional[Tuple[datetime, int]] = None
                for e in c.events:  # already sorted by (started_at, wf_run_id)
                    key = (e.started_at, e.wf_run_id)
                    if key == prev_key:
                        continue
                    filtered.append(e)
                    prev_key = key
                new_commits.append(SignalCommit(head_sha=c.head_sha, events=filtered))
            deduped.append(
                Signal(key=s.key, workflow_name=s.workflow_name, commits=new_commits)
            )
        return deduped

    # -----------------------------
    # Phase B — Tests (test_run_s3 only)
    # -----------------------------
    def _select_test_track_job_ids(
        self, jobs: List[JobRow]
    ) -> Tuple[List[JobId], List[JobId]]:
        """
        Select job_ids for the test-track batch fetch.

        Strategy:
        1) Identify normalized job base names for jobs that exhibited test-related classifications anywhere
            in the window.
        2) Include ALL jobs across all commits whose normalized job base name is in that set
            (to capture successes or pendings on other commits).
        """
        bases_to_track: Set[Tuple[WorkflowName, JobBaseName]] = {
            (j.workflow_name, j.base_name) for j in jobs if j.rule and j.is_test_failure
        }

        if not bases_to_track:
            return [], []

        # All job ids across commits whose base is in the tracked set
        job_ids = {
            j.job_id for j in jobs if (j.workflow_name, j.base_name) in bases_to_track
        }
        # Job ids that exhibited test-failure classifications
        failed_job_ids = {j.job_id for j in jobs if j.rule and j.is_test_failure}

        return list(job_ids), list(failed_job_ids)

    # -----------------------------
    # Build Signals
    # -----------------------------
    def _build_test_signals(
        self,
        jobs: List[JobRow],
        test_rows: List[TestRow],
        commit_shas: List[Sha],
    ) -> List[Signal]:
        """Build per-test Signals across commits, scoped to job base.

        We index `default.test_run_s3` rows per (wf_run_id, run_attempt, job_base) and collect
        which base(s) (by normalized job name) a test appears in. For each commit and (workflow, base),
        we compute attempt metadata (pending/completed, start time). Then, for tests that failed at least once in
        that base, we emit events per commit/attempt:
          - If test_run_s3 rows exist → FAILURE if any failing/errored else SUCCESS
          - Else if group pending → PENDING
          - Else → no event (missing)

        Args:
            jobs: List of job rows from the datasource
            test_rows: List of test rows from the datasource
            commit_shas: Ordered list of commit shas (newest → older)
        """

        jobs_by_id = {j.job_id: j for j in jobs}

        index_by_commit_job_base_wf_run_attempt: JobAggIndex[
            Tuple[Sha, WorkflowName, JobBaseName, WfRunId, RunAttempt]
        ] = JobAggIndex.from_rows(
            jobs,
            key_fn=lambda j: (
                j.head_sha,
                j.workflow_name,
                j.base_name,
                j.wf_run_id,
                j.run_attempt,
            ),
        )

        run_ids_attempts = index_by_commit_job_base_wf_run_attempt.group_map_values_by(
            key_fn=lambda j: (j.head_sha, j.workflow_name, j.base_name),
            value_fn=lambda j: (j.wf_run_id, j.run_attempt),
        )

        # Index test_run_s3 rows per (commit, job_base, wf_run, attempt, test_id) and collect base-scoped failing tests
        tests_by_group_attempt: Dict[
            Tuple[Sha, WorkflowName, JobBaseName, WfRunId, RunAttempt, TestId],
            TestOutcome,
        ] = {}
        failing_tests_by_job_base_name: Set[
            Tuple[WorkflowName, JobBaseName, TestId]
        ] = set()
        for tr in test_rows:
            job = jobs_by_id.get(tr.job_id)
            job_base_name = job.base_name
            key = (
                job.head_sha,
                job.workflow_name,
                job_base_name,
                tr.wf_run_id,
                tr.workflow_run_attempt,
                tr.test_id,
            )
            prev = tests_by_group_attempt.get(key)
            started_at = min(
                (prev.started_at if prev else job.started_at), job.started_at
            )
            outcome = TestOutcome(
                failing=(prev.failing if prev else False) or bool(tr.failing),
                errored=(prev.errored if prev else False) or bool(tr.errored),
                started_at=started_at,
            )
            tests_by_group_attempt[key] = outcome
            if outcome.failing or outcome.errored:
                failing_tests_by_job_base_name.add(
                    (job.workflow_name, job_base_name, tr.test_id)
                )

        # Emit signals per (workflow, jobs_base_name, test_id) across commits
        signals: List[Signal] = []
        for wf_name, job_base_name, test_id in failing_tests_by_job_base_name:
            commit_objs: List[SignalCommit] = []
            has_any_events = (
                False  # if true, signal has at least one event for some commit
            )

            # y-axis: commits (newest → older)
            for commit_sha in commit_shas:
                events: List[SignalEvent] = []

                # x-axis: events for the signal
                for wf_run_id, run_attempt in run_ids_attempts.get(
                    (commit_sha, wf_name, job_base_name), []
                ):
                    meta = index_by_commit_job_base_wf_run_attempt.get_stats(
                        (commit_sha, wf_name, job_base_name, wf_run_id, run_attempt),
                        default=JobMeta(),
                    )
                    if meta.is_cancelled:
                        # canceled attempts are treated as missing
                        continue
                    verdict = tests_by_group_attempt.get(
                        (
                            commit_sha,
                            wf_name,
                            job_base_name,
                            wf_run_id,
                            run_attempt,
                            test_id,
                        )
                    )

                    event_common = {
                        "name": self._fmt_event_name(
                            workflow=wf_name,
                            kind="test",
                            identifier=test_id,
                            wf_run_id=wf_run_id,
                            run_attempt=run_attempt,
                        ),
                        "ended_at": None,
                        "wf_run_id": int(wf_run_id),
                    }

                    if verdict:
                        events.append(
                            SignalEvent(
                                status=SignalStatus.FAILURE
                                if (verdict.failing or verdict.errored)
                                else SignalStatus.SUCCESS,
                                started_at=verdict.started_at,
                                **event_common,
                            )
                        )
                    elif meta.is_pending:
                        events.append(
                            SignalEvent(
                                status=SignalStatus.PENDING,
                                started_at=meta.started_at,
                                **event_common,
                            )
                        )
                    # else: missing (no event)

                if events:
                    has_any_events = True

                # important to always include the commit, even if no events
                commit_objs.append(SignalCommit(head_sha=commit_sha, events=events))

            if has_any_events:
                signals.append(
                    Signal(key=test_id, workflow_name=wf_name, commits=commit_objs)
                )

        return signals

    def _build_non_test_signals(
        self, jobs: List[JobRow], commit_shas: List[Sha]
    ) -> List[Signal]:
        """Build Signals keyed by normalized job base name per workflow.

        Aggregate across shards within (wf_run_id, run_attempt) using JobAggIndex.

        Args:
            jobs: List of job rows from the datasource
            commit_shas: Ordered list of commit shas (newest → older)
        """

        index = JobAggIndex.from_rows(
            jobs,
            key_fn=lambda j: (
                j.head_sha,
                j.workflow_name,
                j.base_name,
                j.wf_run_id,
                j.run_attempt,
            ),
        )

        # Map (sha, workflow, base) -> [attempt_keys]
        groups_index = index.group_keys_by(
            key_fn=lambda j: (j.head_sha, j.workflow_name, j.base_name)
        )

        # Collect all (workflow, base) keys we need to produce signals for
        wf_base_keys: Set[Tuple[WorkflowName, JobBaseName]] = {
            (j.workflow_name, j.base_name) for j in jobs
        }

        signals: List[Signal] = []
        for wf_name, base_name in wf_base_keys:
            commit_objs: List[SignalCommit] = []
            # Track failure types across all attempts/commits for this base
            has_relevant_failures = False  # at least one non-test failure observed

            for sha in commit_shas:
                attempt_keys: List[
                    Tuple[Sha, WorkflowName, JobBaseName, WfRunId, RunAttempt]
                ] = groups_index.get((sha, wf_name, base_name), [])
                events: List[SignalEvent] = []

                for akey in attempt_keys:
                    meta = index.stats(akey)
                    if meta.is_cancelled:
                        # canceled attempts are treated as missing
                        continue
                    # Map aggregation verdict to outer SignalStatus
                    if meta.status is None:
                        continue
                    if meta.status == AggStatus.FAILURE:
                        # mark presence of non-test failures (relevant for job track)
                        if meta.has_non_test_failures:
                            has_relevant_failures = True

                        ev_status = SignalStatus.FAILURE
                    elif meta.status == AggStatus.SUCCESS:
                        ev_status = SignalStatus.SUCCESS
                    else:
                        ev_status = SignalStatus.PENDING

                    # Extract wf_run_id/run_attempt from the attempt key
                    _, _, _, wf_run_id, run_attempt = akey

                    events.append(
                        SignalEvent(
                            name=self._fmt_event_name(
                                workflow=wf_name,
                                kind="job",
                                identifier=base_name,
                                wf_run_id=wf_run_id,
                                run_attempt=run_attempt,
                            ),
                            status=ev_status,
                            started_at=meta.started_at,
                            ended_at=None,
                            wf_run_id=int(wf_run_id),
                        )
                    )

                # important to always include the commit, even if no events
                commit_objs.append(SignalCommit(head_sha=sha, events=events))

            # Emit job signal when failures were present and failures were NOT exclusively test-caused
            if has_relevant_failures:
                signals.append(
                    Signal(key=base_name, workflow_name=wf_name, commits=commit_objs)
                )

        return signals
