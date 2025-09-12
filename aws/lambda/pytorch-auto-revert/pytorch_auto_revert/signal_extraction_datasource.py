from __future__ import annotations

import logging
import time
from datetime import datetime, timedelta
from typing import Any, Dict, Iterable, List

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


class SignalExtractionDatasource:
    """
    Encapsulates ClickHouse queries used by the signal extraction layer.
    """

    def fetch_jobs_for_workflows(
        self, *, repo_full_name: str, workflows: Iterable[str], lookback_hours: int
    ) -> List[JobRow]:
        """
        Fetch recent workflow job rows for the given workflows within the lookback window.

        Returns rows ordered by push timestamp desc, then by workflow run/job identity.
        """
        lookback_time = datetime.now() - timedelta(hours=lookback_hours)

        workflow_filter = ""
        params: Dict[str, Any] = {
            "lookback_time": lookback_time,
            "repo": repo_full_name,
        }
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
            -- Keep-going adjustment via schema alias; see note above
            wf.conclusion_kg AS conclusion_kg,
            wf.started_at,
            wf.created_at,
            tupleElement(wf.torchci_classification_kg,'rule') AS rule
        FROM default.workflow_job AS wf FINAL
        INNER JOIN push_dedup p ON wf.head_sha = p.sha
        WHERE wf.repository_full_name = {{repo:String}}
          AND wf.created_at >= {{lookback_time:DateTime}}
          {workflow_filter}
        ORDER BY p.ts DESC, wf.started_at ASC, wf.head_sha, wf.run_id, wf.run_attempt, wf.name
        """

        log = logging.getLogger(__name__)
        log.info(
            "[extract] Fetching jobs: repo=%s workflows=%s lookback=%sh",
            repo_full_name,
            ",".join(workflow_list) if workflow_list else "<all>",
            lookback_hours,
        )
        t0 = time.perf_counter()
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
                    started_at=started_at,
                    created_at=created_at,
                    rule=str(rule or ""),
                )
            )
        dt = time.perf_counter() - t0
        log.info("[extract] Jobs fetched: %d rows in %.2fs", len(rows), dt)
        return rows

    def fetch_tests_for_job_ids(self, job_ids: List[JobId]) -> List[TestRow]:
        """Batch fetch test verdict rows from default.test_run_s3 for given job ids."""
        log = logging.getLogger(__name__)
        if not job_ids:
            return []

        total = len(job_ids)
        log.info("[extract] Fetching tests for %d job_ids in batches", total)
        rows: List[TestRow] = []
        TEST_FETCH_CHUNK = 300
        t0 = time.perf_counter()
        for start in range(0, total, TEST_FETCH_CHUNK):
            chunk = job_ids[start: start + TEST_FETCH_CHUNK]
            batch_idx = start // TEST_FETCH_CHUNK + 1
            batch_total = (total + TEST_FETCH_CHUNK - 1) // TEST_FETCH_CHUNK
            log.info(
                "[extract] Test batch %d/%d (size=%d)",
                batch_idx,
                batch_total,
                len(chunk),
            )
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
        dt = time.perf_counter() - t0
        log.info(
            "[extract] Tests fetched: %d rows for %d job_ids in %.2fs",
            len(rows),
            total,
            dt,
        )
        return rows
