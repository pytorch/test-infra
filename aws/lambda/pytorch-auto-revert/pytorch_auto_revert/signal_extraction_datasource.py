from __future__ import annotations

import logging
import time
from datetime import datetime, timedelta
from typing import Any, Dict, Iterable, List, Optional

from .clickhouse_client_helper import CHCliFactory
from .signal_extraction_types import (
    JobId,
    JobName,
    JobRow,
    RunAttempt,
    Sha,
    TestRow,
    WfRunId,
    WorkflowName,
)
from .utils import RetryWithBackoff


class SignalExtractionDatasource:
    """
    Encapsulates ClickHouse queries used by the signal extraction layer.
    """

    def fetch_commits_in_time_range(
        self,
        *,
        repo_full_name: str,
        lookback_hours: int,
        as_of: Optional[datetime] = None,
    ) -> List[tuple[Sha, datetime]]:
        """
        Fetch all commits pushed to main within the lookback window.
        Returns list of (sha, timestamp) tuples ordered newest → older.

        Note: Uses ARRAY JOIN to extract all commits from ghstack pushes,
        which can contain multiple commits in a single push event.
        For commits with identical timestamps (from the same ghstack push),
        orders by array index descending to match HUD/torchci ordering.

        Args:
            as_of: If set, use this as the reference time instead of now.
        """
        reference_time = as_of if as_of else datetime.now()
        lookback_time = reference_time - timedelta(hours=lookback_hours)

        # Add upper bound filter only when as_of is specified
        upper_bound_clause = ""
        if as_of:
            upper_bound_clause = "AND head_commit.timestamp <= {as_of:DateTime}"

        query = f"""
        SELECT
            commit.id AS sha,
            max(commit.timestamp) AS ts,
            arrayMax(groupArray(arrayFirstIndex(c -> c.'id' = commit.id, commits))) as array_index
        FROM default.push
        ARRAY JOIN commits as commit, commits as c
        WHERE head_commit.timestamp >= {{lookback_time:DateTime}}
          {upper_bound_clause}
          AND ref = 'refs/heads/main'
          AND dynamoKey like {{repo:String}}
        GROUP BY sha
        ORDER BY ts DESC, array_index DESC
        """

        params: Dict[str, Any] = {
            "lookback_time": lookback_time,
            "repo": f"{repo_full_name}%",
        }
        if as_of:
            params["as_of"] = as_of

        log = logging.getLogger(__name__)
        log.info(
            "[extract] Fetching commits in time range: repo=%s lookback=%sh as_of=%s",
            repo_full_name,
            lookback_hours,
            as_of.isoformat() if as_of else "none",
        )
        log.debug("[extract] Query params: %s", params)
        log.debug("[extract] Query: %s", query)
        t0 = time.perf_counter()
        for attempt in RetryWithBackoff():
            with attempt:
                res = CHCliFactory().client.query(query, parameters=params)
                commits = [(Sha(row[0]), row[1]) for row in res.result_rows]
        dt = time.perf_counter() - t0
        log.info("[extract] Commits fetched: %d commits in %.2fs", len(commits), dt)
        return commits

    def fetch_jobs_for_workflows(
        self,
        *,
        repo_full_name: str,
        workflows: Iterable[str],
        lookback_hours: int,
        head_shas: List[Sha],
        as_of: Optional[datetime] = None,
    ) -> List[JobRow]:
        """
        Fetch workflow job rows for the given head_shas and workflows.

        Returns rows ordered by head_sha (following the order of head_shas), then by started_at ASC.

        Args:
            as_of: If set, use this as the reference time instead of now.
        """
        reference_time = as_of if as_of else datetime.now()
        lookback_time = reference_time - timedelta(hours=lookback_hours)

        # Add upper bound filter only when as_of is specified
        upper_bound_clause = ""
        if as_of:
            upper_bound_clause = "AND wf.created_at <= {as_of:DateTime}"

        workflow_filter = ""
        params: Dict[str, Any] = {
            "lookback_time": lookback_time,
            "repo": repo_full_name,
            "head_shas": [str(s) for s in head_shas],
        }
        if as_of:
            params["as_of"] = as_of
        workflow_list = list(workflows)
        if workflow_list:
            workflow_filter = "AND wf.workflow_name IN {workflows:Array(String)}"
            params["workflows"] = workflow_list

        # NOTE(keep-going semantics):
        # Some jobs run with GitHub Actions' keep-going behavior, where the raw
        # `conclusion` can be an empty string even when a failure has been
        # detected by our classification pipeline. To avoid losing failure
        # information in Phase A, we must use the KG-adjusted alias
        # `wf.conclusion_kg`, which maps such keep-going cases to 'failure'.
        #
        # Do not "optimize" this away by selecting `wf.conclusion` directly —
        # the extractor and downstream logic rely on the KG-adjusted value so
        # that pending jobs can also be recognized as failures-in-progress.
        query = f"""
        SELECT
            wf.head_sha,
            wf.workflow_name,
            wf.id AS job_id,
            wf.run_id,
            wf.run_attempt,
            wf.name,
            wf.status,
            -- Keep-going adjustment via schema alias; see note above
            wf.conclusion_kg AS conclusion_kg,
            wf.started_at,
            wf.created_at,
            tupleElement(wf.torchci_classification_kg,'rule') AS rule
        FROM default.workflow_job AS wf FINAL
        WHERE wf.repository_full_name = {{repo:String}}
          AND wf.head_sha IN {{head_shas:Array(String)}}
          AND wf.created_at >= {{lookback_time:DateTime}}
          {upper_bound_clause}
          AND (
                wf.name NOT LIKE '%mem_leak_check%'
                AND wf.name NOT LIKE '%rerun_disabled_tests%'
                AND wf.name NOT LIKE '%unstable%'
            )
          {workflow_filter}
        ORDER BY wf.head_sha, wf.started_at ASC, wf.run_id, wf.run_attempt, wf.name
        """

        log = logging.getLogger(__name__)
        log.info(
            "[extract] Fetching jobs: repo=%s workflows=%s commits=%d lookback=%sh",
            repo_full_name,
            ",".join(workflow_list) if workflow_list else "<all>",
            len(head_shas),
            lookback_hours,
        )
        t0 = time.perf_counter()
        for attempt in RetryWithBackoff():
            with attempt:
                res = CHCliFactory().client.query(query, parameters=params)
                rows: List[JobRow] = []
                for (
                    head_sha,
                    workflow_name,
                    job_id,
                    run_id,
                    run_attempt,
                    name,
                    status,
                    conclusion,  # Note: this is `conclusion_kg` from the query above
                    started_at,
                    created_at,
                    rule,
                ) in res.result_rows:
                    # Guard against placeholder started_at by using the later of
                    # started_at and created_at as the effective start.
                    # Both columns are non-NULL in ClickHouse.
                    effective_started = max(started_at, created_at)
                    rows.append(
                        JobRow(
                            head_sha=Sha(head_sha),
                            workflow_name=WorkflowName(workflow_name),
                            wf_run_id=WfRunId(int(run_id)),
                            job_id=JobId(int(job_id)),
                            run_attempt=RunAttempt(int(run_attempt)),
                            name=JobName(str(name or "")),
                            status=str(status or ""),
                            conclusion=str(conclusion or ""),
                            started_at=effective_started,
                            created_at=created_at,
                            rule=str(rule or ""),
                        )
                    )
        dt = time.perf_counter() - t0
        log.info("[extract] Jobs fetched: %d rows in %.2fs", len(rows), dt)
        return rows

    def fetch_tests_for_job_ids(
        self,
        job_ids: List[JobId],
        *,
        failed_job_ids: List[JobId],
        lookback_hours: int,
    ) -> List[TestRow]:
        """Batch fetch test verdict rows from tests.all_test_runs for given job ids.

        If failed_job_ids is provided, first compute the set of failed test identifiers
        (file+classname+name) from those jobs, and only fetch tests for job_ids that
        match that set. This reduces the result size significantly.
        Additionally, constrain by the table's partition (toDate(time_inserted))
        using NOW() and the lookback window with a 1-day margin to avoid timezone issues.
        """
        log = logging.getLogger(__name__)
        if not job_ids:
            return []
        if not failed_job_ids:
            # No failed jobs -> no failed test ids to project; nothing to return
            return []

        total = len(job_ids)
        log.info(
            "[extract] Fetching tests for %d job_ids (%d failed jobs) in batches",
            total,
            len(failed_job_ids),
        )
        rows: List[TestRow] = []
        TEST_FETCH_CHUNK = 1024  # Number of job_ids to fetch per query
        t0 = time.perf_counter()
        for start in range(0, total, TEST_FETCH_CHUNK):
            chunk = job_ids[start : start + TEST_FETCH_CHUNK]
            batch_idx = start // TEST_FETCH_CHUNK + 1
            batch_total = (total + TEST_FETCH_CHUNK - 1) // TEST_FETCH_CHUNK
            log.info(
                "[extract] Test batch %d/%d (size=%d)",
                batch_idx,
                batch_total,
                len(chunk),
            )
            # One query with a CTE that enumerates failed test ids from failed_job_ids,
            # then filters the main selection by those ids for the current chunk.
            # Partition pruning: restrict toDate(time_inserted) to the lookback window
            # with a 1 day margin using NOW() to avoid timezone handling.
            query = """
                WITH failed_test_names AS (
                    SELECT DISTINCT concat(file, '|', classname, '|', name) AS test_id
                    FROM tests.all_test_runs
                    WHERE job_id IN {failed_job_ids:Array(Int64)}
                      AND (failure_count > 0 OR error_count > 0)
                      AND toDate(time_inserted) >=
                          toDate(NOW() - toIntervalHour({lookback_hours:Int32}) - toIntervalDay(1))
                )
                SELECT job_id, workflow_id, workflow_run_attempt, file, classname, name,
                       countIf(failure_count > 0 OR error_count > 0) AS failure_runs,
                       countIf(failure_count = 0 AND error_count = 0 AND skipped_count = 0) AS success_runs
                FROM tests.all_test_runs
                WHERE job_id IN {job_ids:Array(Int64)}
                  AND concat(file, '|', classname, '|', name) IN failed_test_names
                  AND toDate(time_inserted) >=
                      toDate(NOW() - toIntervalHour({lookback_hours:Int32}) - toIntervalDay(1))
                GROUP BY job_id, workflow_id, workflow_run_attempt, file, classname, name
            """
            params = {
                "job_ids": [int(j) for j in chunk],
                "failed_job_ids": [int(j) for j in failed_job_ids],
                "lookback_hours": int(lookback_hours),
            }

            for attempt in RetryWithBackoff():
                with attempt:
                    res = CHCliFactory().client.query(query, parameters=params)
                    for r in res.result_rows:
                        rows.append(
                            TestRow(
                                job_id=JobId(int(r[0])),
                                wf_run_id=WfRunId(int(r[1])),
                                workflow_run_attempt=RunAttempt(int(r[2])),
                                file=str(r[3] or ""),
                                classname=str(r[4] or ""),
                                name=str(r[5] or ""),
                                failure_runs=int(r[6] or 0),
                                success_runs=int(r[7] or 0),
                            )
                        )
        dt = time.perf_counter() - t0
        log.info(
            "[extract] Tests fetched: %d rows for %d job_ids in %.2fs",
            len(rows),
            total,
            dt,
        )
        return rows

    def fetch_autorevert_state_rows(
        self,
        *,
        ts: str,
        repo_full_name: Optional[str] = None,
        workflow: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Fetch run state rows from misc.autorevert_state for a given timestamp."""

        query = (
            "SELECT repo, workflows, state FROM misc.autorevert_state "
            "WHERE ts = parseDateTimeBestEffort({ts:String})"
        )
        params: Dict[str, Any] = {"ts": ts}
        if repo_full_name:
            query += " AND repo = {repo:String}"
            params["repo"] = repo_full_name
        if workflow:
            query += " AND has(workflows, {workflow:String})"
            params["workflow"] = workflow

        for attempt in RetryWithBackoff():
            with attempt:
                res = CHCliFactory().client.query(query, parameters=params)
                rows: List[Dict[str, Any]] = []
                for repo, workflows, state_json in res.result_rows:
                    rows.append(
                        {
                            "repo": repo,
                            "workflows": workflows,
                            "state": state_json,
                        }
                    )
                return rows

    def fetch_latest_non_dry_run_timestamp(
        self, *, repo_full_name: Optional[str] = None, workflow: Optional[str] = None
    ) -> Optional[str]:
        """Return the most recent non-dry-run autorevert_state timestamp."""

        query = "SELECT ts FROM misc.autorevert_state WHERE dry_run = 0"
        params: Dict[str, Any] = {}
        if repo_full_name:
            query += " AND repo = {repo:String}"
            params["repo"] = repo_full_name
        if workflow:
            query += " AND has(workflows, {workflow:String})"
            params["workflow"] = workflow
        query += " ORDER BY ts DESC LIMIT 1"

        for attempt in RetryWithBackoff():
            with attempt:
                res = CHCliFactory().client.query(query, parameters=params)
                if not res.result_rows:
                    return None

                (ts_value,) = res.result_rows[0]
                if isinstance(ts_value, datetime):
                    return ts_value.strftime("%Y-%m-%d %H:%M:%S")
                return str(ts_value)
