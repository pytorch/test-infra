"""Enumerate currently-unclassified trunk reds from ClickHouse (read-only).

Runs the two `sql.py` queries per window and assembles `RedSignal` objects: one
per unclassified red, carrying the failing job run plus a few green
baseline-before runs of the same job for advisor context.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from pytorch_auto_revert.clickhouse_client_helper import CHCliFactory
from pytorch_auto_revert.utils import RetryWithBackoff

from .config import BASELINE_GREEN_COMMITS, CoverageConfig
from .sql import (
    QUERY_BASELINES,
    QUERY_UNCLASSIFIED,
    WORKFLOW_FILTER_CLAUSE,
    WORKFLOW_FILTER_MARKER,
)


log = logging.getLogger(__name__)


@dataclass(frozen=True)
class JobRun:
    """A concrete workflow_job run."""

    name: str
    job_id: int
    wf_run_id: int
    run_attempt: int
    started_at: Optional[datetime]
    ended_at: Optional[datetime]


@dataclass(frozen=True)
class BaselineCommit:
    """A green baseline-before commit for the same job."""

    sha: str
    commit_time: Optional[datetime]
    run: JobRun


@dataclass(frozen=True)
class RedSignal:
    """One unclassified trunk red, keyed to the observed trunk commit."""

    observed_commit: str
    commit_time: Optional[datetime]
    workflow_name: str
    job_name: str  # full name (with runner) → signal_key + suspect event
    job_base_name: str  # runner-dropped form (advisor context)
    suspect: JobRun
    baselines: List[BaselineCommit]


def _naive_utc(dt: datetime) -> datetime:
    """ClickHouse push/workflow_job timestamps are UTC-naive; match that."""
    if dt.tzinfo is not None:
        return dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


class UnclassifiedRedEnumerator:
    """Enumerate category=5 (unclassified) trunk reds for a time window."""

    def __init__(self, config: CoverageConfig) -> None:
        self.config = config

    def enumerate(self, start: datetime, stop: datetime) -> List[RedSignal]:
        reds = self._query_unclassified(start, stop)
        if not reds:
            return []
        cons_names = sorted({r["cons_name"] for r in reds})
        baselines = self._query_baselines(start, stop, cons_names)
        return [self._assemble(r, baselines) for r in reds]

    # ------------------------------------------------------------------
    def _query_unclassified(
        self, start: datetime, stop: datetime
    ) -> List[Dict[str, Any]]:
        query = self._apply_workflow_filter(QUERY_UNCLASSIFIED)
        params: Dict[str, Any] = {
            "repo": self.config.repo_full_name,
            "startTime": _naive_utc(start),
            "stopTime": _naive_utc(stop),
            "minRuns": self.config.min_runs,
        }
        if self.config.workflows:
            params["workflows"] = list(self.config.workflows)
        return self._run(query, params)

    def _query_baselines(
        self, start: datetime, stop: datetime, cons_names: List[str]
    ) -> Dict[Tuple[str, str], List[BaselineCommit]]:
        query = self._apply_workflow_filter(QUERY_BASELINES)
        params: Dict[str, Any] = {
            "repo": self.config.repo_full_name,
            "startTime": _naive_utc(start),
            "stopTime": _naive_utc(stop),
            "consNames": cons_names,
        }
        if self.config.workflows:
            params["workflows"] = list(self.config.workflows)

        by_job: Dict[Tuple[str, str], List[BaselineCommit]] = defaultdict(list)
        for row in self._run(query, params):
            key = (row["workflow_name"], row["cons_name"])
            by_job[key].append(
                BaselineCommit(
                    sha=row["head_sha"],
                    commit_time=row["commit_time"],
                    run=_job_run(row),
                )
            )
        # Rows arrive newest-first (ORDER BY commit_time DESC).
        return by_job

    def _apply_workflow_filter(self, query: str) -> str:
        clause = WORKFLOW_FILTER_CLAUSE if self.config.workflows else ""
        return query.replace(WORKFLOW_FILTER_MARKER, clause)

    def _run(self, query: str, params: Dict[str, Any]) -> List[Dict[str, Any]]:
        for attempt in RetryWithBackoff():
            with attempt:
                res = CHCliFactory().client.query(query, parameters=params)
                cols = res.column_names
                return [dict(zip(cols, row)) for row in res.result_rows]

    def _assemble(
        self,
        red: Dict[str, Any],
        baselines: Dict[Tuple[str, str], List[BaselineCommit]],
    ) -> RedSignal:
        commit_time = red["commit_time"]
        key = (red["workflow_name"], red["cons_name"])
        picked = [
            b
            for b in baselines.get(key, [])
            if commit_time is None
            or b.commit_time is None
            or b.commit_time < commit_time
        ][:BASELINE_GREEN_COMMITS]
        return RedSignal(
            observed_commit=red["head_sha"],
            commit_time=commit_time,
            workflow_name=red["workflow_name"],
            job_name=red["name"],
            job_base_name=red["cons_name"],
            suspect=_job_run(red),
            baselines=picked,
        )


def _job_run(row: Dict[str, Any]) -> JobRun:
    return JobRun(
        name=row["name"],
        job_id=int(row["job_id"]),
        wf_run_id=int(row["run_id"]),
        run_attempt=int(row["run_attempt"]),
        started_at=row.get("started_at"),
        ended_at=row.get("completed_at"),
    )
