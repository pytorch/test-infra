from __future__ import annotations


"""
Signal extraction layer.

Transforms raw workflow/job/test data into Signal objects used by signal.py.
"""

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Dict, Iterable, List, Optional, Set, Tuple

from .job_agg_index import JobAggIndex, JobMeta, SignalStatus as AggStatus
from .signal import (
    AdvisorVerdict,
    AIAdvisorResult,
    Signal,
    SignalCommit,
    SignalEvent,
    SignalSource,
    SignalStatus,
)
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
    failure_runs: int  # count of failed test runs
    success_runs: int  # count of successful test runs
    started_at: datetime
    job_id: int


class SignalExtractor:
    def __init__(
        self,
        workflows: Iterable[str],
        lookback_hours: int = 24,
        repo_full_name: str = "pytorch/pytorch",
        as_of: Optional[datetime] = None,
    ) -> None:
        self.workflows = list(workflows)
        self.lookback_hours = lookback_hours
        self.repo_full_name = repo_full_name
        self.as_of = as_of
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
            as_of=self.as_of,
        )

        # Fetch jobs for these commits
        jobs = self._datasource.fetch_jobs_for_workflows(
            repo_full_name=self.repo_full_name,
            workflows=self.workflows,
            lookback_hours=self.lookback_hours,
            head_shas=[sha for sha, _ in commits],
            as_of=self.as_of,
        )

        # Select jobs to participate in test-track details fetch
        test_track_job_ids, failed_job_ids = self._select_test_track_job_ids(jobs)
        test_rows = self._datasource.fetch_tests_for_job_ids(
            test_track_job_ids,
            failed_job_ids=failed_job_ids,
            lookback_hours=self.lookback_hours,
        )

        test_signals = self._build_test_signals(jobs, test_rows, commits)
        job_signals = self._build_non_test_signals(jobs, commits)
        job_test_signals = self._build_non_test_signals(
            jobs, commits, test_failures=True
        )
        # Deduplicate events within commits across all signals as a final step
        # GitHub-specific behavior like "rerun failed" can reuse job instances for reruns.
        # When that happens, the jobs have identical timestamps by DIFFERENT job ids.
        # But since they are still the same job logically, we want to deduplicate them
        # for the purposes of signal events.
        signals = self._dedup_signal_events(
            test_signals + job_signals + job_test_signals
        )

        # Inject synthetic PENDING events for workflow runs that are known to be
        # pending but have no events in a given signal (e.g. multi-stage workflows).
        signals = self._inject_pending_workflow_events(signals, jobs)

        # Attach AI advisor verdicts to SignalCommit objects
        return self._attach_advisor_verdicts(signals, commits)

    # -----------------------------
    # Deduplication (GitHub-specific)
    # -----------------------------
    def _dedup_signal_events(self, signals: List[Signal]) -> List[Signal]:
        deduped: List[Signal] = []
        for s in signals:
            new_commits: List[SignalCommit] = []
            for c in s.commits:
                filtered: List[SignalEvent] = []
                # Include status in the key so we can retain both a FAILURE and
                # a SUCCESS emitted at the same (started_at, wf_run_id)
                prev_key: Optional[Tuple[datetime, int, SignalStatus]] = None
                for e in c.events:  # already sorted by (started_at, wf_run_id)
                    key = (e.started_at, e.wf_run_id, e.status)
                    if key == prev_key:
                        continue
                    filtered.append(e)
                    prev_key = key
                new_commits.append(c.replace(events=filtered))
            deduped.append(s.replace(commits=new_commits))
        return deduped

    # -----------------------------
    # Pending workflow synthesis
    # -----------------------------
    def _inject_pending_workflow_events(
        self,
        signals: List[Signal],
        jobs: List[JobRow],
    ) -> List[Signal]:
        """
        For each signal/commit, if there exists a pending workflow run and the
        signal has no event for that wf_run_id, insert a synthetic PENDING event
        with started_at set slightly in the future (now + 1 minute).
        """
        if not signals or not jobs:
            return signals

        # Simple pass over JobRows to collect pending workflow run ids per (sha, workflow)
        pending_runs: Dict[Tuple[Sha, WorkflowName], Set[int]] = {}
        for j in jobs:
            if j.is_pending:
                pending_runs.setdefault((j.head_sha, j.workflow_name), set()).add(
                    int(j.wf_run_id)
                )

        # Avoid deprecated utcnow(); derive UTC then store naive to match existing code
        now_plus = (datetime.now(timezone.utc) + timedelta(minutes=1)).replace(
            tzinfo=None
        )

        out: List[Signal] = []
        for s in signals:
            new_commits: List[SignalCommit] = []
            for c in s.commits:
                pending_ids = pending_runs.get(
                    (Sha(c.head_sha), WorkflowName(s.workflow_name))
                )
                if not pending_ids:
                    new_commits.append(c)
                    continue

                have_ids = {e.wf_run_id for e in c.events}
                missing_ids = pending_ids - have_ids
                if not missing_ids:
                    new_commits.append(c)
                    continue

                # Build synthetic pending events for the missing wf_run_ids
                # set started_at to the future
                synth_events: List[SignalEvent] = list(c.events)
                for wf_run_id in missing_ids:
                    name = self._fmt_event_name(
                        workflow=s.workflow_name,
                        kind="synthetic",
                        identifier=str(s.key),
                        wf_run_id=WfRunId(wf_run_id),
                        run_attempt=RunAttempt(0),
                    )
                    synth_events.append(
                        SignalEvent(
                            name=name,
                            status=SignalStatus.PENDING,
                            started_at=now_plus,
                            ended_at=None,
                            wf_run_id=int(wf_run_id),
                            run_attempt=0,
                            job_id=None,
                        )
                    )
                new_commits.append(c.replace(events=synth_events))

            out.append(s.replace(commits=new_commits))
        return out

    # -----------------------------
    # Advisor verdict attachment
    # -----------------------------
    def _attach_advisor_verdicts(
        self,
        signals: List[Signal],
        commits: List[Tuple[Sha, datetime]],
    ) -> List[Signal]:
        """Fetch advisor verdicts from CH and attach to SignalCommit objects.

        For each (commit_sha, signal_key) pair that has a verdict in
        misc.autorevert_advisor_verdicts, sets the advisor_result field
        on the corresponding SignalCommit.
        """
        head_shas = [sha for sha, _ in commits]
        signal_keys = list({s.key for s in signals})
        verdicts = self._datasource.fetch_advisor_verdicts(
            repo_full_name=self.repo_full_name,
            head_shas=head_shas,
            signal_keys=signal_keys,
            lookback_hours=self.lookback_hours,
        )
        if not verdicts:
            return signals

        out: List[Signal] = []
        for s in signals:
            new_commits: List[SignalCommit] = []
            for c in s.commits:
                key = (c.head_sha.strip(), s.key)
                v = verdicts.get(key)
                if v is not None:
                    verdict_str, confidence, ts = v
                    try:
                        advisor_verdict = AdvisorVerdict(verdict_str)
                    except ValueError:
                        advisor_verdict = AdvisorVerdict.UNSURE
                    advisor_result = AIAdvisorResult(
                        verdict=advisor_verdict,
                        confidence=confidence,
                        timestamp=ts,
                        signal_key=s.key,
                    )
                    new_commits.append(c.replace(advisor_result=advisor_result))
                else:
                    new_commits.append(c)
            out.append(s.replace(commits=new_commits))
        return out

    # -----------------------------
    # Phase B — Tests (tests.all_test_runs only)
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
        commits: List[Tuple[Sha, datetime]],
    ) -> List[Signal]:
        """Build per-test Signals across commits, scoped to job base.

        We index `tests.all_test_runs` rows per (wf_run_id, run_attempt, job_base) and collect
        which base(s) (by normalized job name) a test appears in. For each commit and (workflow, base),
        we compute attempt metadata (pending/completed, start time). Then, for tests that failed at least once in
        that base, we emit events per commit/attempt:
          - If tests.all_test_runs rows exist → emit at most one FAILURE event if any failed runs exist,
            and at most one SUCCESS event if any successful runs exist (both may be present).
          - Else if group pending → PENDING
          - Else → no event (missing)

        Args:
            jobs: List of job rows from the datasource
            test_rows: List of test rows from the datasource
            commits: Ordered list of (sha, timestamp) tuples (newest → older)
        """

        jobs_by_id = {j.job_id: j for j in jobs}
        commit_timestamps = dict(commits)

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

        # Index tests.all_test_runs rows per (commit, job_base, wf_run, attempt, test_id)
        # Store aggregated failure/success counts
        tests_by_group_attempt: Dict[
            Tuple[Sha, WorkflowName, JobBaseName, WfRunId, RunAttempt, TestId],
            TestOutcome,
        ] = {}
        failing_tests_by_job_base_name: Set[
            Tuple[WorkflowName, JobBaseName, TestId]
        ] = set()
        # Capture structured test identity per test_id so we can attach it
        # once at the Signal level. The TestRow `test_id` property collapses
        # to "file::name" and drops classname, so one test_id may span
        # multiple classes; collect all distinct non-empty classnames and
        # only surface one later if it is unambiguous.
        test_file_name_by_test_id: Dict[TestId, Tuple[str, str]] = {}
        test_classnames_by_test_id: Dict[TestId, Set[str]] = {}
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
            outcome = TestOutcome(
                failure_runs=tr.failure_runs,
                success_runs=tr.success_runs,
                started_at=job.started_at,
                job_id=int(tr.job_id),
            )
            # Combine outcomes across shards/partitions for the same group key.
            # Outcome with failures takes precedence.
            # This is to support a rare case where a test appears in multiple shards
            # usually it indicates that our base_name normalization is not perfect.
            existing = tests_by_group_attempt.get(key)
            if existing is not None and existing.failure_runs > 0:
                outcome = existing

            tests_by_group_attempt[key] = outcome
            test_file_name_by_test_id.setdefault(tr.test_id, (tr.file, tr.name))
            if tr.classname:
                test_classnames_by_test_id.setdefault(tr.test_id, set()).add(
                    tr.classname
                )

            # Track keys that have at least one persistent failure (no retry success)
            if outcome.failure_runs > 0 and outcome.success_runs == 0:
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
            for commit_sha, _ in commits:
                events: List[SignalEvent] = []
                # Track whether this test's job group ran to a terminal
                # conclusion on this commit via a NATURAL run: ≥1 non-cancelled,
                # non-skipped, non-workflow_dispatch run, and none still pending.
                # A naturally-concluded commit with no events is a born-red
                # baseline witness (the test was genuinely absent), as opposed
                # to a commit whose jobs are still running (no info yet) or were
                # only exercised by an autorevert restart (which is job/test-
                # filtered and so cannot prove the test absent).
                group_runs = 0
                group_pending = False
                # True once autorevert has dispatched a restart on this commit's
                # job group (a workflow_dispatch run is present, pending or
                # concluded). Drives `SignalCommit.has_dispatch_run` so the gap
                # bisection won't restart the same commit twice.
                group_had_dispatch = False

                # x-axis: events for the signal
                for wf_run_id, run_attempt in run_ids_attempts.get(
                    (commit_sha, wf_name, job_base_name), []
                ):
                    meta = index_by_commit_job_base_wf_run_attempt.get_stats(
                        (commit_sha, wf_name, job_base_name, wf_run_id, run_attempt),
                        default=JobMeta(),
                    )
                    if meta.is_cancelled or meta.is_skipped:
                        # Cancelled / skipped attempts are treated as missing
                        # (same as JobMeta.status → None). A skipped job — an
                        # `if:` gate, or a required-check skip when an upstream
                        # dependency failed/cancelled — never ran the test, so
                        # it is NOT proof the test was absent. Counting it would
                        # fabricate a born-red baseline witness.
                        continue
                    # Only NATURAL runs (push/schedule) establish the born-red
                    # baseline. An autorevert workflow_dispatch restart is
                    # job/test-filtered, so a concluded dispatch with no event
                    # for this test is not proof of absence. Dispatch runs still
                    # emit their outcome/pending events below — so a gap-restart
                    # that the test fails still surfaces a FAILURE and moves the
                    # suspect — they just don't count toward `job_group_concluded`.
                    if meta.is_workflow_dispatch:
                        # A restart we already dispatched on this commit — probed
                        # once, so the gap bisection must not restart it again.
                        group_had_dispatch = True
                    else:
                        group_runs += 1
                        if meta.is_pending:
                            group_pending = True
                    outcome = tests_by_group_attempt.get(
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
                        "run_attempt": int(run_attempt),
                    }

                    if outcome:
                        # A successful retry means the test is not persistently
                        # broken — treat it as SUCCESS, consistent with HUD and
                        # job-level conclusion which consider retried-then-passed
                        # tests as "flaky" (not "failure").
                        if outcome.success_runs > 0:
                            events.append(
                                SignalEvent(
                                    status=SignalStatus.SUCCESS,
                                    started_at=outcome.started_at,
                                    job_id=outcome.job_id,
                                    **event_common,
                                )
                            )
                        elif outcome.failure_runs > 0:
                            events.append(
                                SignalEvent(
                                    status=SignalStatus.FAILURE,
                                    started_at=outcome.started_at,
                                    job_id=outcome.job_id,
                                    **event_common,
                                )
                            )
                    elif meta.is_pending:
                        events.append(
                            SignalEvent(
                                status=SignalStatus.PENDING,
                                started_at=meta.started_at,
                                job_id=meta.job_id,
                                **event_common,
                            )
                        )
                    # else: missing (no event)

                if events:
                    has_any_events = True

                # important to always include the commit, even if no events
                commit_objs.append(
                    SignalCommit(
                        head_sha=commit_sha,
                        timestamp=commit_timestamps[commit_sha],
                        events=events,
                        job_group_concluded=(group_runs > 0 and not group_pending),
                        has_dispatch_run=group_had_dispatch,
                    )
                )

            if has_any_events:
                # Extract test module from test_id (format: "file.py::test_name").
                # When the CH row's `file` column is empty, TestRow.test_id falls
                # back to the bare `name` (no `::`) and we can't derive a path
                # that `run_test.py --include` would accept. Mark such signals
                # as untargeted (test_module=None) so the action layer dispatches
                # them without a tests-to-include filter (job-style restart),
                # rather than emitting a bogus method-named module that argparse
                # would reject with "invalid choice".
                if "::" in test_id:
                    test_module = test_id.split("::")[0].replace(".py", "")
                else:
                    test_module = None
                test_file, test_name = test_file_name_by_test_id.get(test_id, ("", ""))
                # Classname is only trustworthy when a single distinct value
                # was seen for this test_id; otherwise omit rather than guess.
                classnames = test_classnames_by_test_id.get(test_id, set())
                test_classname = (
                    next(iter(classnames)) if len(classnames) == 1 else None
                )

                signals.append(
                    Signal(
                        key=test_id,
                        workflow_name=wf_name,
                        commits=commit_objs,
                        job_base_name=str(job_base_name),
                        test_module=test_module,
                        source=SignalSource.TEST,
                        test_file=test_file or None,
                        test_classname=test_classname or None,
                        test_name=test_name or None,
                    )
                )

        return signals

    def _build_non_test_signals(
        self,
        jobs: List[JobRow],
        commits: List[Tuple[Sha, datetime]],
        *,
        test_failures: bool = False,
    ) -> List[Signal]:
        """Build Signals keyed by normalized job base name per workflow.

        Aggregate across shards within (wf_run_id, run_attempt) using JobAggIndex.

        When test_failures=False (default), only non-test failures produce FAILURE
        events (test-caused failures are mapped to SUCCESS, handled by test-track).

        When test_failures=True, ALL failures produce FAILURE events. The signal
        is only created when at least one commit has a test-caused failure, but
        non-test failures (e.g. build) also map to FAILURE because they may mask
        underlying test failures on the same commit.
        This catches new tests without a green base and tests missing from the
        tests.all_test_runs table.

        Args:
            jobs: List of job rows from the datasource
            commits: Ordered list of (sha, timestamp) tuples (newest → older)
            test_failures: If True, track test-caused failures instead of non-test failures
        """

        commit_timestamps = dict(commits)

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
            has_relevant_failures = False

            for sha, _ in commits:
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
                        # Two passes call this method: one for non-test failures
                        # (test_failures=False), one for test-caused failures
                        # (test_failures=True).
                        if test_failures:
                            # Map ALL failures to FAILURE: a build failure may
                            # mask underlying test failures on the same commit,
                            # so we can't safely treat it as SUCCESS.
                            # Only mark signal as relevant when test failures
                            # exist, to avoid creating [test] signals for bases
                            # that only have build failures.
                            ev_status = SignalStatus.FAILURE
                            if not meta.has_non_test_failures:
                                has_relevant_failures = True
                        elif meta.has_non_test_failures:
                            has_relevant_failures = True
                            ev_status = SignalStatus.FAILURE
                        else:
                            ev_status = SignalStatus.SUCCESS
                    elif meta.status == AggStatus.PENDING:
                        ev_status = SignalStatus.PENDING
                    else:
                        ev_status = SignalStatus.SUCCESS

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
                            run_attempt=int(run_attempt),
                            job_id=meta.job_id,
                        )
                    )

                # important to always include the commit, even if no events
                commit_objs.append(
                    SignalCommit(
                        head_sha=sha, timestamp=commit_timestamps[sha], events=events
                    )
                )

            if has_relevant_failures:
                signal_key = f"{base_name} [test]" if test_failures else base_name
                signals.append(
                    Signal(
                        key=signal_key,
                        workflow_name=wf_name,
                        commits=commit_objs,
                        job_base_name=str(base_name),
                        source=SignalSource.JOB,
                    )
                )

        return signals
