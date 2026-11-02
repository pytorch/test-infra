"""Read jobs and test runs from ClickHouse for job_trace."""

from __future__ import annotations

from typing import Any, Dict, List, Sequence, Tuple

from torchci.clickhouse import query_clickhouse


# One row per step (LEFT ARRAY JOIN keeps jobs without steps).
JOBS_QUERY = """
SELECT j.id AS job, j.name AS name, j.html_url AS url, j.conclusion AS conclusion,
  j.runner_name AS runner, arrayStringConcat(j.labels, ',') AS labels,
  toUnixTimestamp64Milli(j.started_at) AS start_ms, toUnixTimestamp64Milli(j.completed_at) AS end_ms,
  tupleElement(s, 'name') AS step, tupleElement(s, 'conclusion') AS step_conclusion,
  toUnixTimestamp64Milli(tupleElement(s, 'started_at')) AS step_start_ms,
  toUnixTimestamp64Milli(tupleElement(s, 'completed_at')) AS step_end_ms
FROM (
  SELECT id, name, html_url, conclusion, runner_name, labels, started_at, completed_at, steps
  FROM default.workflow_job WHERE id IN {job_ids:Array(Int64)}
  ORDER BY _inserted_at DESC LIMIT 1 BY id
) j
LEFT ARRAY JOIN j.steps AS s
"""

# The by_job projection serves the github_workflow_job_id filter. Owners come
# from ci.owners per file; an empty owner keeps every file.
RUNS_QUERY = """
SELECT r.job AS job, t.file AS file, t.suite AS suite, t.case_name AS case_name, t.owners AS owners,
  r.report AS report, r.rerun_number AS rerun_number, r.outcome AS outcome, r.summary AS summary,
  r.start_ms AS start_ms, r.end_ms AS end_ms
FROM (
  SELECT github_workflow_job_id AS job, tests_id, toString(report_uuid) AS report, rerun_number,
    toString(outcome) AS outcome, substringUTF8(outcome_summary, 1, 500) AS summary,
    toUnixTimestamp64Milli(started_at) AS start_ms, toUnixTimestamp64Milli(ended_at) AS end_ms
  FROM ci.runs
  WHERE github_workflow_job_id IN {job_ids:Array(Int64)}
  LIMIT 1 BY id
) r
JOIN (
  SELECT t.id AS id, t.file AS file, t.suite AS suite, t.case_name AS case_name,
    arrayStringConcat(o.owners, ',') AS owners
  FROM (
    SELECT id, any(repo) AS repo, any(file) AS file, any(suite) AS suite, any(case_name) AS case_name
    FROM ci.tests
    WHERE id IN (SELECT tests_id FROM ci.runs WHERE github_workflow_job_id IN {job_ids:Array(Int64)})
    GROUP BY id
  ) t
  LEFT JOIN (SELECT repo, file, owners FROM ci.owners FINAL) o ON o.repo = t.repo AND o.file = t.file
  WHERE {owner:String} = '' OR has(o.owners, {owner:String})
) t ON t.id = r.tests_id
"""

# JSONEachRow quotes 64-bit integers, so convert these back.
_INT_FIELDS = (
    "job",
    "start_ms",
    "end_ms",
    "step_start_ms",
    "step_end_ms",
    "rerun_number",
)


def _ints(row: Dict[str, Any]) -> Dict[str, Any]:
    return {k: int(v) if k in _INT_FIELDS else v for k, v in row.items()}


def fetch(
    job_ids: Sequence[int], owner: str = ""
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """(job rows, run rows) for job_ids, runs limited to owner's files if given."""
    params = {"job_ids": list(job_ids), "owner": owner}
    jobs = [
        _ints(r) for r in query_clickhouse(JOBS_QUERY, {"job_ids": params["job_ids"]})
    ]
    runs = [_ints(r) for r in query_clickhouse(RUNS_QUERY, params)]
    return jobs, runs
