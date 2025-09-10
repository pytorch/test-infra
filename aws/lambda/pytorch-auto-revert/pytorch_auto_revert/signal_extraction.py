from __future__ import annotations


"""
Signal extraction layer.

Transforms raw workflow/job/test data into Signal objects used by signal.py.
"""

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Dict, Iterable, List, NewType, Optional, Set, Tuple

from .autorevert_checker import CommitJobs
from .clickhouse_client_helper import CHCliFactory
from .signal import Signal, SignalCommit, SignalEvent, SignalStatus


# Default classification rules that indicate test failures.
DEFAULT_TEST_RULES: Set[str] = {
    "pytest failure",
    "Python unittest failure",
}

# Stronger typing for ids (type-checker only; runtime is still int/str)
WfRunId = NewType("WfRunId", int)
RunAttempt = NewType("RunAttempt", int)
JobId = NewType("JobId", int)
Sha = NewType("Sha", str)
WorkflowName = NewType("WorkflowName", str)
JobName = NewType("JobName", str)
JobBaseName = NewType("JobBaseName", str)
TestId = NewType("TestId", str)


@dataclass(frozen=True)
class JobRow:
    head_sha: Sha
    workflow_name: WorkflowName
    wf_run_id: WfRunId
    job_id: JobId
    run_attempt: RunAttempt
    name: JobName
    status: str
    conclusion: str
    started_at: Optional[datetime]
    created_at: Optional[datetime]
    rule: str


@dataclass(frozen=True)
class TestRow:
    job_id: JobId
    wf_run_id: WfRunId
    workflow_run_attempt: RunAttempt
    file: str
    classname: str
    name: str
    failing: int  # 0/1
    errored: int  # 0/1

    @property
    def test_id(self) -> TestId:
        # file::name is a stable, readable key; classname can be added if needed
        test_key = f"{self.file}::{self.name}" if self.file else self.name
        return TestId(test_key)


@dataclass
class Commit:
    sha: Sha
    # Map of (workflow, job_base_name) -> ordered JobRow list (by started_at)
    jobs: Dict[Tuple[WorkflowName, JobBaseName], List[JobRow]]


@dataclass(frozen=True)
class TestOutcome:
    failing: bool
    errored: bool


class SignalExtractor:
    def __init__(
        self,
        workflows: Iterable[str],
        lookback_hours: int = 24,
        test_rules: Optional[Set[str]] = None,
    ) -> None:
        self.workflows = list(workflows)
        self.lookback_hours = lookback_hours
        self.test_rules = (
            set(test_rules) if test_rules is not None else set(DEFAULT_TEST_RULES)
        )
        # Helper instance to reuse normalization logic
        self._norm_dummy = CommitJobs(head_sha="_", created_at=datetime.now(), jobs=[])

    def _norm(self, name: str) -> str:
        return self._norm_dummy.normalize_job_name(name or "")

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
    # Small helpers (readability / reuse)
    # -----------------------------
    @staticmethod
    def _earliest_started_at(rows: List[JobRow]) -> datetime:
        """Earliest non-null started_at among rows; datetime.min if none present."""
        return min((r.started_at for r in rows if r.started_at is not None), default=datetime.min)

    @staticmethod
    def _any_pending(rows: List[JobRow]) -> bool:
        """True if any row has a non-completed status."""
        return any(((r.status or "").lower() != "completed") for r in rows)

    @staticmethod
    def _any_canceled(rows: List[JobRow]) -> bool:
        """True if any row concluded as cancelled (DB uses 'cancelled')."""
        return any(((r.conclusion or "").lower() == "cancelled") for r in rows)

    @staticmethod
    def _any_failure(rows: List[JobRow]) -> bool:
        """True if any row concluded as failure."""
        return any(((r.conclusion or "").lower() == "failure") for r in rows)

    @staticmethod
    def _all_completed_success(rows: List[JobRow]) -> bool:
        """True if all rows concluded as success and are completed."""
        return all(
            ((r.conclusion or "").lower() == "success") and ((r.status or "").lower() == "completed")
            for r in rows
        )

    # -----------------------------
    # Public API
    # -----------------------------
    def extract(self) -> List[Signal]:
        """Extract Signals for configured workflows within the lookback window."""
        commits = self._fetch_commits_and_jobs()

        # Select jobs to participate in test-track details fetch
        test_track_job_ids, bases_to_track = self._select_test_track_job_ids(commits)
        test_rows = self._fetch_tests_for_jobs(test_track_job_ids)

        test_signals = self._build_test_signals(commits, test_rows, bases_to_track)
        job_signals = self._build_non_test_signals(commits)
        return test_signals + job_signals

    # -----------------------------
    # Phase A — Jobs
    # -----------------------------
    def _fetch_commits_and_jobs(self) -> List[Commit]:
        """
        Fetch workflow jobs for recent main commits plus any other workflow runs for those commits
        (including dispatches). Returns mapping (workflow_name, head_sha) -> list of _JobRow
        ordered by started_at (None last) for stable event ordering.
        """
        lookback_time = datetime.now() - timedelta(hours=self.lookback_hours)

        workflow_filter = ""
        params: Dict[str, Any] = {"lookback_time": lookback_time}
        if self.workflows:
            workflow_filter = "AND wf.workflow_name IN {workflows:Array(String)}"
            params["workflows"] = self.workflows

        query = f"""
        WITH push_dedup AS (
            SELECT head_commit.id AS sha, max(head_commit.timestamp) AS ts
            FROM default.push
            WHERE head_commit.timestamp >= {{lookback_time:DateTime}}
              AND ref = 'refs/heads/main'
            GROUP BY sha
        )
        SELECT
            wf.head_sha,
            wf.workflow_name,
            wf.id AS job_id,
            wf.run_id,
            wf.run_attempt,
            wf.name,
            wf.status,
            if(wf.conclusion = '' AND
                tupleElement(wf.torchci_classification_temp,'line') != '', 'failure', wf.conclusion)
                AS conclusion_kg,
            wf.started_at,
            wf.created_at,
            tupleElement(wf.torchci_classification_kg,'rule') AS rule
        FROM default.workflow_job AS wf FINAL
        INNER JOIN push_dedup p ON wf.head_sha = p.sha
        WHERE wf.dynamoKey LIKE 'pytorch/pytorch/%'
          AND wf.created_at >= {{lookback_time:DateTime}}
          {workflow_filter}
        ORDER BY p.ts DESC, wf.head_sha, wf.run_id, wf.run_attempt, wf.name, wf.started_at
        """

        res = CHCliFactory().client.query(query, parameters=params)
        commits: List[Commit] = []
        current_sha: Optional[Sha] = None
        current_jobs: Dict[Tuple[WorkflowName, JobBaseName], List[JobRow]] = {}

        def flush_current():
            if current_sha is not None:
                # sort each job list by started_at for stable event ordering
                for lst in current_jobs.values():
                    lst.sort(
                        key=lambda r: (r.started_at is None, r.started_at, r.job_id)
                    )
                commits.append(Commit(sha=current_sha, jobs=dict(current_jobs)))

        for (
            head_sha,
            workflow_name,
            job_id,
            run_id,
            run_attempt,
            name,
            status,
            conclusion,
            started_at,
            created_at,
            rule,
        ) in res.result_rows:
            # boundary by head_sha – rows are ordered by push ts desc, head_sha grouping
            if current_sha is None:
                current_sha = Sha(head_sha)
            elif Sha(head_sha) != current_sha:
                flush_current()
                current_sha = Sha(head_sha)
                current_jobs = {}

            k: Tuple[WorkflowName, JobBaseName] = (
                WorkflowName(workflow_name),
                (JobBaseName(self._norm(name))),
            )
            current_jobs.setdefault(k, []).append(
                JobRow(
                    head_sha=current_sha,
                    workflow_name=WorkflowName(workflow_name),
                    wf_run_id=WfRunId(int(run_id)),
                    job_id=JobId(int(job_id)),
                    run_attempt=RunAttempt(int(run_attempt)),
                    name=JobName(str(name or "")),
                    status=str(status or ""),
                    conclusion=str(conclusion or ""),
                    started_at=started_at,
                    created_at=created_at,
                    rule=str(rule or ""),
                )
            )

        flush_current()
        return commits

    # -----------------------------
    # Phase B — Tests (test_run_s3 only)
    # -----------------------------
    def _select_test_track_job_ids(
        self, commits: List[Commit]
    ) -> Tuple[List[JobId], Set[Tuple[WorkflowName, JobBaseName]]]:
        """
        Select job_ids for the test-track batch fetch.

        Strategy:
        1) Identify normalized job base names for jobs that exhibited test-related classifications anywhere in the window.
        2) Include ALL jobs across all commits whose normalized job base name is in that set
            (to capture successes or pendings on other commits).
        """
        # Helper for normalization (reuse CommitJobs implementation)
        bases_to_track: Set[Tuple[WorkflowName, JobBaseName]] = set()
        for commit in commits:
            for key, rows in commit.jobs.items():
                for j in rows:
                    if j.rule and j.rule in self.test_rules:
                        bases_to_track.add(key)
                        break

        if not bases_to_track:
            return [], set()

        job_ids: List[JobId] = []
        seen: Set[JobId] = set()
        for commit in commits:
            for base_key, rows in commit.jobs.items():
                if base_key in bases_to_track:
                    for j in rows:
                        if j.job_id not in seen:
                            seen.add(j.job_id)
                            job_ids.append(j.job_id)
        return job_ids, bases_to_track

    def _fetch_tests_for_jobs(self, job_ids: List[JobId]) -> List[TestRow]:
        if not job_ids:
            return []

        rows: List[TestRow] = []
        # Chunk to avoid very large IN lists
        TEST_FETCH_CHUNK = 300
        for start in range(0, len(job_ids), TEST_FETCH_CHUNK):
            chunk = job_ids[start : start + TEST_FETCH_CHUNK]
            res = CHCliFactory().client.query(
                """
                SELECT job_id, workflow_id, workflow_run_attempt, file, classname, name,
                       max(failure_count > 0) AS failing,
                       max(error_count  > 0) AS errored
                FROM default.test_run_s3
                WHERE job_id IN {job_ids:Array(Int64)}
                GROUP BY job_id, workflow_id, workflow_run_attempt, file, classname, name
                """,
                parameters={"job_ids": [int(j) for j in chunk]},
            )
            for r in res.result_rows:
                rows.append(
                    TestRow(
                        job_id=JobId(int(r[0])),
                        wf_run_id=WfRunId(int(r[1])),
                        workflow_run_attempt=RunAttempt(int(r[2])),
                        file=str(r[3] or ""),
                        classname=str(r[4] or ""),
                        name=str(r[5] or ""),
                        failing=int(r[6] or 0),
                        errored=int(r[7] or 0),
                    )
                )
        return rows

    # -----------------------------
    # Build Signals
    # -----------------------------
    def _build_test_signals(
        self,
        commits: List[Commit],
        test_rows: List[TestRow],
        bases_to_track: Set[Tuple[WorkflowName, JobBaseName]],
    ) -> List[Signal]:
        """Build per-test Signals across commits, scoped to job base.

        We index `default.test_run_s3` rows per (wf_run_id, run_attempt, job_base) and collect
        which base(s) (by normalized job name) a test appears in. For each commit and (workflow, base), we compute attempt
        metadata (pending/completed, start time). Then, for tests that failed at least once in
        that base, we emit events per commit/attempt:
          - If test_run_s3 rows exist → FAILURE if any failing/errored else SUCCESS
          - Else if group pending → PENDING
          - Else → no event (missing)
        """

        # Map job_id -> (commit_sha, base key) for fast base resolution
        @dataclass(frozen=True)
        class JobLoc:
            sha: Sha
            base: Tuple[WorkflowName, JobBaseName]

        job_loc: Dict[JobId, JobLoc] = {}
        # Keyed by (commit sha, workflow name, job base name) → list of attempts
        attempts_by_commit_base: Dict[
            Tuple[Sha, WorkflowName, JobBaseName], List[Tuple[WfRunId, RunAttempt]]
        ] = {}

        @dataclass(frozen=True)
        class GroupMeta:
            """Per (commit, base, attempt) metadata used to derive event status.

            - started_at: earliest start time among rows in the group (for ordering)
            - pending: at least one row in the group is not completed
            - canceled: at least one row concluded as cancelled; group is treated as missing signal
            """

            started_at: Optional[datetime]
            pending: bool
            canceled: bool

        # Keyed by (sha, workflow, base, wf_run_id, run_attempt)
        group_meta: Dict[
            Tuple[Sha, WorkflowName, JobBaseName, WfRunId, RunAttempt], GroupMeta
        ] = {}

        for c in commits:
            for (wf_name, base_name), rows in c.jobs.items():
                base_key = (wf_name, base_name)
                if base_key not in bases_to_track:
                    continue
                by_attempt: Dict[Tuple[WfRunId, RunAttempt], List[JobRow]] = {}
                for j in rows:
                    job_loc[j.job_id] = JobLoc(c.sha, base_key)
                    by_attempt.setdefault((j.wf_run_id, j.run_attempt), []).append(j)

                for (wf_run_id, run_attempt), grows in by_attempt.items():
                    group_meta[(c.sha, wf_name, base_name, wf_run_id, run_attempt)] = GroupMeta(
                        started_at=(self._earliest_started_at(grows)), pending=(self._any_pending(grows)),
                        canceled=(self._any_canceled(grows))
                    )
                    attempts_by_commit_base.setdefault((c.sha, wf_name, base_name), []).append(
                        (wf_run_id, run_attempt)
                    )

        # Index test_run_s3 rows per (commit, base, attempt) and collect base-scoped failing tests
        tests_by_group_attempt: Dict[
            Tuple[Sha, WorkflowName, JobBaseName, WfRunId, RunAttempt],
            Dict[TestId, TestOutcome],
        ] = {}
        failing_tests_by_base: Dict[Tuple[WorkflowName, JobBaseName], Set[TestId]] = {}
        for tr in test_rows:
            loc = job_loc.get(tr.job_id)
            if not loc:
                continue
            wf_name, base_name = loc.base
            key = (loc.sha, wf_name, base_name, tr.wf_run_id, tr.workflow_run_attempt)
            d = tests_by_group_attempt.setdefault(key, {})
            prev = d.get(tr.test_id)
            outcome = TestOutcome(
                failing=(prev.failing if prev else False) or bool(tr.failing),
                errored=(prev.errored if prev else False) or bool(tr.errored),
            )
            d[tr.test_id] = outcome
            if outcome.failing or outcome.errored:
                failing_tests_by_base.setdefault(loc.base, set()).add(tr.test_id)

        # Emit per (workflow, base, test) across commits
        signals: List[Signal] = []
        for (wf_name, base_name), failing_tests in failing_tests_by_base.items():
            for test_id in failing_tests:
                commit_objs: List[SignalCommit] = []
                any_event = False
                for c in commits:
                    events: List[SignalEvent] = []
                    for wf_run_id, run_attempt in attempts_by_commit_base.get(
                        (c.sha, wf_name, base_name), []
                    ):
                        meta = group_meta.get(
                            (c.sha, wf_name, base_name, wf_run_id, run_attempt),
                            GroupMeta(started_at=None, pending=False, canceled=False),
                        )
                        if meta.canceled:
                            # canceled attempts are treated as missing
                            continue
                        verdicts = tests_by_group_attempt.get(
                            (c.sha, wf_name, base_name, wf_run_id, run_attempt)
                        )
                        def make_event(ev_status: SignalStatus) -> SignalEvent:
                            return SignalEvent(
                                    name=self._fmt_event_name(
                                        workflow=wf_name,
                                        kind="test",
                                        identifier=test_id,
                                        wf_run_id=wf_run_id,
                                        run_attempt=run_attempt,
                                    ),
                                status=ev_status,
                                    started_at=meta.started_at or datetime.min,
                                    ended_at=None,
                                )

                        if verdicts and test_id in verdicts:
                            oc = verdicts[test_id]
                            events.append(make_event(
                                SignalStatus.FAILURE
                                if (oc.failing or oc.errored)
                                else SignalStatus.SUCCESS
                            ))
                        elif meta.pending:
                            events.append(make_event(SignalStatus.PENDING))
                        # else: missing (no event)

                    if events:
                        any_event = True
                    commit_objs.append(SignalCommit(head_sha=c.sha, events=events))

                if any_event:
                    signals.append(
                        Signal(key=test_id, workflow_name=wf_name, commits=commit_objs)
                    )

        return signals

    def _build_non_test_signals(self, commits: List[Commit]) -> List[Signal]:
        # Build Signals keyed by normalized job base name per workflow
        # Aggregate across shards within (wf_run_id, run_attempt)
        signals_by_key: Dict[Tuple[WorkflowName, JobBaseName], List[SignalCommit]] = {}

        for c in commits:
            # For each commit, process each (workflow, base) group
            for (wf_name, base_name), rows in c.jobs.items():
                by_attempt: Dict[Tuple[WfRunId, RunAttempt], List[JobRow]] = {}
                for j in rows:
                    by_attempt.setdefault((j.wf_run_id, j.run_attempt), []).append(j)

                events: List[SignalEvent] = []
                for (wf_run_id, run_attempt), grows in by_attempt.items():
                    any_fail = self._any_failure(grows)
                    any_canceled = self._any_canceled(grows)
                    all_success = self._all_completed_success(grows)
                    if any_canceled:
                        # treat canceled groups as missing signal; skip event
                        continue
                    status = (
                        SignalStatus.FAILURE
                        if any_fail
                        else (
                            SignalStatus.SUCCESS
                            if all_success
                            else SignalStatus.PENDING
                        )
                    )
                    started_at = self._earliest_started_at(grows)
                    events.append(
                        SignalEvent(
                            name=self._fmt_event_name(
                                workflow=wf_name,
                                kind="job",
                                identifier=base_name,
                                wf_run_id=wf_run_id,
                                run_attempt=run_attempt,
                            ),
                            status=status,
                            started_at=started_at,
                            ended_at=None,
                        )
                    )

                commit_obj = SignalCommit(head_sha=c.sha, events=events)
                signals_by_key.setdefault((wf_name, base_name), []).append(commit_obj)

        # Materialize Signals newest → older (already ordered from the query)
        out: List[Signal] = []
        for (wf_name, base_name), commit_list in signals_by_key.items():
            out.append(
                Signal(key=base_name, workflow_name=wf_name, commits=commit_list)
            )
        return out
