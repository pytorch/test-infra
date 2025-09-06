from __future__ import annotations

"""
Signal extraction layer.

Transforms raw workflow/job/test data into Signal objects used by signal.py.
"""

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Dict, Iterable, List, Optional, Tuple, DefaultDict, Set

from .clickhouse_client_helper import CHCliFactory
from .autorevert_checker import CommitJobs, JobResult
from .signal import Signal, SignalCommit, SignalEvent, SignalStatus


# Default classification rules that indicate test failures.
DEFAULT_TEST_RULES: Set[str] = {
    "pytest failure",
    "Python unittest failure",
}


@dataclass(frozen=True)
class JobRow:
    head_sha: str
    workflow_name: str
    wf_run_id: int
    job_id: int
    run_attempt: int
    name: str
    status: str
    conclusion: str
    started_at: Optional[datetime]
    created_at: Optional[datetime]
    rule: str


@dataclass(frozen=True)
class TestRow:
    job_id: int
    wf_run_id: int
    workflow_run_attempt: int
    file: str
    classname: str
    name: str
    failing: int  # 0/1
    errored: int  # 0/1
    rerun_seen: int  # 0/1

    @property
    def test_id(self) -> str:
        # file::name is a stable, readable key; classname can be added if needed
        return f"{self.file}::{self.name}" if self.file else self.name


@dataclass(frozen=True)
class JobBaseNameKey:
    workflow: str
    job_base_name: str


@dataclass
class Commit:
    sha: str
    # Map of (workflow, job_base_name) -> ordered JobRow list (by started_at)
    jobs: Dict[JobBaseNameKey, List[JobRow]]


# ---------- Type aliases & small keys for clarity ----------

@dataclass(frozen=True)
class AttemptKey:
    """Identifies a unique workflow run attempt for grouping events."""

    wf_run_id: int
    run_attempt: int


@dataclass(frozen=True)
class AttemptIndexKey:
    """Index key for test rows: job, run, attempt triple."""

    wf_run_id: int
    job_id: int
    run_attempt: int


@dataclass(frozen=True)
class TestOutcome:
    failing: bool
    errored: bool


@dataclass(frozen=True)
class WorkflowCommitRows:
    sha: str
    rows: List[JobRow]


class SignalExtractor:
    def __init__(
        self,
        workflows: Iterable[str],
        lookback_hours: int = 24,
        test_rules: Optional[Set[str]] = None,
    ) -> None:
        self.workflows = list(workflows)
        self.lookback_hours = lookback_hours
        self.test_rules = set(test_rules) if test_rules is not None else set(DEFAULT_TEST_RULES)
        # Helper instance to reuse normalization logic
        self._norm_dummy = CommitJobs(head_sha="_", created_at=datetime.now(), jobs=[])

    def _norm(self, name: str) -> str:
        return self._norm_dummy.normalize_job_name(name or "")

    def _fmt_event_name(
        self, *, workflow: str, kind: str, identifier: str, wf_run_id: int, run_attempt: int
    ) -> str:
        """Consistent, debuggable event name for SignalEvent."""
        return f"wf={workflow} kind={kind} id={identifier} run={wf_run_id} attempt={run_attempt}"

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
            if(wf.conclusion = '' AND tupleElement(wf.torchci_classification_temp,'line') != '', 'failure', wf.conclusion) AS conclusion_kg,
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
        current_sha: Optional[str] = None
        current_jobs: Dict[JobBaseNameKey, List[JobRow]] = {}

        def flush_current():
            if current_sha is not None:
                # sort each job list by started_at for stable event ordering
                for lst in current_jobs.values():
                    lst.sort(key=lambda r: (r.started_at is None, r.started_at, r.job_id))
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
                current_sha = head_sha
            elif head_sha != current_sha:
                flush_current()
                current_sha = head_sha
                current_jobs = {}

            base = self._norm(name)
            k = JobBaseNameKey(workflow=workflow_name, job_base_name=base)
            current_jobs.setdefault(k, []).append(
                JobRow(
                    head_sha=head_sha,
                    workflow_name=workflow_name,
                    wf_run_id=int(run_id),
                    job_id=int(job_id),
                    run_attempt=int(run_attempt),
                    name=str(name or ""),
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
    ) -> Tuple[List[int], set[JobBaseNameKey]]:
        """
        Select job_ids for the test-track batch fetch.

        Strategy:
        1) Identify normalized base names for jobs that exhibited test-related classifications anywhere in the window.
        2) Include ALL jobs across all commits whose normalized base is in that set (to capture successes or pendings on other commits).
        """
        # Helper for normalization (reuse CommitJobs implementation)
        bases_to_track: set[JobBaseNameKey] = set()
        for commit in commits:
            for key, rows in commit.jobs.items():
                for j in rows:
                    if j.rule and j.rule in self.test_rules:
                        bases_to_track.add(key)
                        break

        job_ids: List[int] = []
        seen = set()
        if bases_to_track:
            for commit in commits:
                for key, rows in commit.jobs.items():
                    if key in bases_to_track:
                        for j in rows:
                            if j.job_id not in seen:
                                seen.add(j.job_id)
                                job_ids.append(j.job_id)
        return job_ids, bases_to_track

    def _fetch_tests_for_jobs(self, job_ids: List[int]) -> List[TestRow]:
        if not job_ids:
            return []

        rows: List[TestRow] = []
        # Chunk to avoid very large IN lists
        CHUNK = 300
        for i in range(0, len(job_ids), CHUNK):
            chunk = job_ids[i : i + CHUNK]
            res = CHCliFactory().client.query(
                """
                SELECT job_id, workflow_id, workflow_run_attempt, file, classname, name,
                       max(failure_count > 0) AS failing,
                       max(error_count  > 0) AS errored,
                       max(rerun_count  > 0) AS rerun_seen,
                       count() AS rows
                FROM default.test_run_s3
                WHERE job_id IN {job_ids:Array(Int64)}
                GROUP BY job_id, workflow_id, workflow_run_attempt, file, classname, name
                """,
                parameters={"job_ids": chunk},
            )
            for r in res.result_rows:
                rows.append(
                    TestRow(
                        job_id=int(r[0]),
                        wf_run_id=int(r[1]),
                        workflow_run_attempt=int(r[2]),
                        file=str(r[3] or ""),
                        classname=str(r[4] or ""),
                        name=str(r[5] or ""),
                        failing=int(r[6] or 0),
                        errored=int(r[7] or 0),
                        rerun_seen=int(r[8] or 0),
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
        bases_to_track: set[JobBaseNameKey],
    ) -> List[Signal]:
        """Build per-test Signals across commits, scoped to job base.

        We index `default.test_run_s3` rows per (wf_run_id, run_attempt, job_base) and collect
        which base(s) a test appears in. For each commit and (workflow, base), we compute attempt
        metadata (pending/completed, start time). Then, for tests that failed at least once in
        that base, we emit events per commit/attempt:
          - If test_run_s3 rows exist → FAILURE if any failing/errored else SUCCESS
          - Else if group pending → PENDING
          - Else → no event (missing)
        """

        # Map job_id -> (commit_sha, base key) for fast base resolution
        @dataclass(frozen=True)
        class JobLoc:
            sha: str
            base: JobBaseNameKey

        job_loc: Dict[int, JobLoc] = {}
        attempts_by_commit_base: Dict[Tuple[str, JobBaseNameKey], List[AttemptKey]] = {}

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

        group_meta: Dict[Tuple[str, JobBaseNameKey, AttemptKey], GroupMeta] = {}

        for c in commits:
            for base_key, rows in c.jobs.items():
                if base_key not in bases_to_track:
                    continue
                by_attempt: Dict[AttemptKey, List[JobRow]] = {}
                for j in rows:
                    job_loc[j.job_id] = JobLoc(c.sha, base_key)
                    by_attempt.setdefault(AttemptKey(j.wf_run_id, j.run_attempt), []).append(j)

                for akey, grows in by_attempt.items():
                    started_at = min((r.started_at for r in grows if r.started_at is not None), default=None)
                    any_pending = any((r.status or "").lower() != "completed" for r in grows)
                    any_canceled = any((r.conclusion or "").lower() == "cancelled" for r in grows)
                    group_meta[(c.sha, base_key, akey)] = GroupMeta(
                        started_at=started_at, pending=any_pending, canceled=any_canceled
                    )
                    attempts_by_commit_base.setdefault((c.sha, base_key), []).append(akey)

        # Index test_run_s3 rows per (commit, base, attempt) and collect base-scoped failing tests
        tests_by_group_attempt: Dict[Tuple[str, JobBaseNameKey, AttemptKey], Dict[str, TestOutcome]] = {}
        failing_tests_by_base: Dict[JobBaseNameKey, Set[str]] = {}
        for tr in test_rows:
            loc = job_loc.get(tr.job_id)
            if not loc:
                continue
            akey = AttemptKey(tr.wf_run_id, tr.workflow_run_attempt)
            key = (loc.sha, loc.base, akey)
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
        for base_key, failing_tests in failing_tests_by_base.items():
            for test_id in failing_tests:
                commit_objs: List[SignalCommit] = []
                any_event = False
                for c in commits:
                    events: List[SignalEvent] = []
                    akeys = attempts_by_commit_base.get((c.sha, base_key), [])
                    for akey in akeys:
                        meta = group_meta.get((c.sha, base_key, akey), GroupMeta(None, False, False))
                        if meta.canceled:
                            # canceled attempts are treated as missing
                            continue
                        verdicts = tests_by_group_attempt.get((c.sha, base_key, akey))
                        if verdicts and test_id in verdicts:
                            oc = verdicts[test_id]
                            status = SignalStatus.FAILURE if (oc.failing or oc.errored) else SignalStatus.SUCCESS
                            events.append(
                                SignalEvent(
                                    name=self._fmt_event_name(
                                        workflow=base_key.workflow,
                                        kind="test",
                                        identifier=test_id,
                                        wf_run_id=akey.wf_run_id,
                                        run_attempt=akey.run_attempt,
                                    ),
                                    status=status,
                                    started_at=meta.started_at or datetime.min,
                                    ended_at=None,
                                )
                            )
                        elif meta.pending:
                            events.append(
                                SignalEvent(
                                    name=self._fmt_event_name(
                                        workflow=base_key.workflow,
                                        kind="test",
                                        identifier=test_id,
                                        wf_run_id=akey.wf_run_id,
                                        run_attempt=akey.run_attempt,
                                    ),
                                    status=SignalStatus.PENDING,
                                    started_at=meta.started_at or datetime.min,
                                    ended_at=None,
                                )
                            )
                        # else: missing (no event)

                    if events:
                        any_event = True
                    commit_objs.append(SignalCommit(head_sha=c.sha, events=events))

                if any_event:
                    signals.append(
                        Signal(key=test_id, workflow_name=base_key.workflow, commits=commit_objs)
                    )

        return signals


    def _build_non_test_signals(
        self, commits: List[Commit]
    ) -> List[Signal]:
        # Build Signals keyed by normalized job base name per workflow
        # Aggregate across shards within (run_id, run_attempt)
        signals_by_key: Dict[Tuple[str, str], List[SignalCommit]] = {}

        for c in commits:
            # For each commit, process each (workflow, base) group
            for key, rows in c.jobs.items():
                by_attempt: Dict[Tuple[int, int], List[JobRow]] = {}
                for j in rows:
                    by_attempt.setdefault((j.wf_run_id, j.run_attempt), []).append(j)

                events: List[SignalEvent] = []
                for (wf_run_id, run_attempt), grows in by_attempt.items():
                    any_fail = any((gr.conclusion or "").lower() == "failure" for gr in grows)
                    any_cancel = any((gr.conclusion or "").lower() == "cancelled" for gr in grows)
                    all_success = all(
                        (gr.conclusion or "").lower() == "success"
                        and (gr.status or "").lower() == "completed"
                        for gr in grows
                    )
                    if any_cancel:
                        # treat canceled groups as missing signal; skip event
                        continue
                    status = (
                        SignalStatus.FAILURE
                        if any_fail
                        else (SignalStatus.SUCCESS if all_success else SignalStatus.PENDING)
                    )
                    started_at = min(
                        (r.started_at for r in grows if r.started_at is not None),
                        default=None,
                    )
                    events.append(
                        SignalEvent(
                            name=self._fmt_event_name(
                                workflow=key.workflow,
                                kind="job",
                                identifier=key.job_base_name,
                                wf_run_id=wf_run_id,
                                run_attempt=run_attempt,
                            ),
                            status=status,
                            started_at=started_at or datetime.min,
                            ended_at=None,
                        )
                    )

                commit_obj = SignalCommit(head_sha=c.sha, events=events)
                signals_by_key.setdefault((key.workflow, key.job_base_name), []).append(commit_obj)

        # Materialize Signals newest → older (already ordered from the query)
        out: List[Signal] = []
        for (wf, base), commit_list in signals_by_key.items():
            out.append(Signal(key=base, workflow_name=wf, commits=commit_list))
        return out
