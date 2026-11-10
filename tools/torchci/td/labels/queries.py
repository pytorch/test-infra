"""The label builder's ClickHouse queries and the fetches the unit kinds share. Every
value is a bound parameter and every query is read-only and capped in time, threads and
result size; the TD scope and the TD metric columns come from torchci.td.llm.events_sql,
which follows pytorch's run_test.py."""

import logging
import time
from datetime import datetime
from typing import Any, Iterable

from torchci.td.labels.schema import DAY, sql_time
from torchci.td.llm import events
from torchci.td.llm.events import E2Event
from torchci.td.llm.events_sql import (
    E2_SQL,
    METRIC_FILTER,
    RANK_COLUMNS,
    SETTINGS as LLM_SETTINGS,
)


logger = logging.getLogger(__name__)

BATCH = 500
LARGE_BATCH = 2000
RAN_BATCH = 200
# PR labels need their jobs' test reports, which are kept about a year; E2 reads the TD
# metric this far back.
PR_LOOK_BACK_DAYS = 365
SETTINGS = LLM_SETTINGS + ", max_result_rows = 20000000, max_result_bytes = 4000000000"


def ch(name: str, sql: str, params: dict[str, Any]) -> list[dict[str, Any]]:
    t0 = time.monotonic()
    rows = events._query(name, sql, params)
    logger.info("%s: %d rows in %.1f s", name, len(rows), time.monotonic() - t0)
    return rows


def batched(items: list[Any], size: int = BATCH) -> Iterable[list[Any]]:
    for i in range(0, len(items), size):
        yield items[i : i + size]


MAIN_PUSHES = f"""
SELECT head_commit.id AS push_sha, repository.pushed_at AS pushed_at,
    commits.id AS commit_shas,
    splitByChar('\\n', head_commit.message)[1] AS title
FROM default.push FINAL
WHERE ref = 'refs/heads/main' AND repository.full_name = 'pytorch/pytorch'
    AND repository.pushed_at >= toUnixTimestamp({{start: DateTime}})
    AND repository.pushed_at < toUnixTimestamp({{stop: DateTime}})
ORDER BY pushed_at
{SETTINGS}
"""

# Test job names are "<env> / test (<config>, <shard>, <shards>, <runner>)", some with
# "test-osdc" for "test"; `n` is the name with that mapped.
TEST_JOB_NAME = "replaceOne(name, ' / test-osdc (', ' / test (') AS n"
TEST_JOB_FIELDS = """
    trimBoth(splitByString(' / test (', n)[1]) AS build_environment,
    trimBoth(splitByChar(',', splitByString(' / test (', n)[2])[1]) AS test_config,
    toInt32OrZero(trimBoth(splitByChar(',', splitByString(' / test (', n)[2])[2])) AS shard,
    toInt32OrZero(trimBoth(splitByChar(',', splitByString(' / test (', n)[2])[3])) AS shards
"""
TEST_JOB_FILTER = "(name LIKE '% / test (%' OR name LIKE '% / test-osdc (%')"
JOBS_AT_HEADS = """
    WHERE id IN (
        SELECT id FROM materialized_views.workflow_job_by_head_sha
        WHERE head_sha IN {shas: Array(String)}
    )
"""

MAIN_JOBS = f"""
SELECT head_sha AS push_sha, workflow, {TEST_JOB_FIELDS}, conclusion, job_id
FROM (
    SELECT head_sha, workflow_name AS workflow, {TEST_JOB_NAME}, conclusion,
        id AS job_id
    FROM default.workflow_job FINAL {JOBS_AT_HEADS}
        AND workflow_name IN ('pull', 'trunk') AND head_branch = 'main'
        AND {TEST_JOB_FILTER}
)
{SETTINGS}
"""

# Test jobs at the given heads (every shard and attempt of every config).
HEAD_JOBS = f"""
SELECT job_id, run_id, run_attempt, head_sha, workflow, created, {TEST_JOB_FIELDS}
FROM (
    SELECT id AS job_id, run_id, run_attempt, head_sha, workflow_name AS workflow,
        toUnixTimestamp(created_at) AS created, {TEST_JOB_NAME}
    FROM default.workflow_job FINAL {JOBS_AT_HEADS} AND {TEST_JOB_FILTER}
)
{SETTINGS}
"""

# Failing test files of the given failed jobs: a case that failed or errored (a case
# that only reran and passed has neither).
FAILED_FILES = f"""
SELECT job_id, replaceAll(invoking_file, '.', '/') AS file
FROM default.failed_test_runs
WHERE job_id IN {{job_ids: Array(Int64)}}
    AND (length(failure) > 0 OR length(error) > 0)
GROUP BY job_id, file
{SETTINGS}
"""

# Per (PR, file): the first TD-off row (macOS, XPU, ONNX builds, where every test of the
# config runs), and in how many jobs and heads the file failed. PR numbers of ciflow tag
# runs come from the tag, as in torchci.td.llm's E2 query.
PR_FAIL_EXTRA = f"""
WITH
    metric_rows AS (
        SELECT pr_number, {RANK_COLUMNS} FROM misc.ossci_uploaded_metrics
        WHERE {METRIC_FILTER} AND timestamp >= {{start: DateTime64(3)}}
            AND timestamp < {{stop: DateTime64(3)}}
            AND JSONExtractFloat(info, 'max_score') > 0
    ),
    runs AS (
        SELECT id, head_sha, head_branch FROM default.workflow_run
        WHERE id IN (SELECT run_id FROM metric_rows) LIMIT 1 BY id
    ),
    tagged AS (
        SELECT m.*, w.head_sha AS head_sha,
            if(m.pr_number > 0, m.pr_number,
                toInt64OrZero(extract(w.head_branch, '^ciflow/[^/]+/(\\\\d+)$'))) AS pr,
            multiSearchAny(m.build_environment, ['macos', 'xpu', 'onnx']) AS td_off
        FROM metric_rows AS m LEFT JOIN runs AS w ON w.id = m.run_id
    )
SELECT pr AS pr_number, test_file, uniqExact(job_id) AS n_jobs, uniqExact(head_sha) AS n_heads,
    minIf(timestamp, td_off) AS off_failed_at,
    argMinIf(tuple(run_id, job_id, workflow, build_environment, test_config, head_sha,
        JSONExtractInt(info, 'position'), JSONLength(info, 'selected_tests'),
        JSONExtractRaw(info, 'all_scores')), tuple(timestamp, job_id), td_off) AS off
FROM tagged WHERE pr > 0
GROUP BY pr_number, test_file
{SETTINGS}
"""

# Test files that ran in the given jobs. test_run_summary is sorted by (run, job) and
# lists more files per job than tests.all_test_runs, but it starts in October 2026 and
# lacks some jobs: RAN_FILES_ALL fills those in.
# `failed`: files with a failed or errored case in the report.
RAN_FILES = f"""
SELECT job_id, groupUniqArray(f) AS ran, groupUniqArrayIf(f, failures + errors > 0) AS failed
FROM (
    SELECT job_id, replaceAll(invoking_file, '.', '/') AS f, failures, errors
    FROM default.test_run_summary
    WHERE workflow_id IN {{run_ids: Array(Int64)}}
        AND job_id IN {{job_ids: Array(Int64)}}
)
GROUP BY job_id
{SETTINGS}
"""

RAN_FILES_ALL = f"""
SELECT job_id, groupUniqArray(f) AS ran,
    groupUniqArrayIf(f, failure_count + error_count > 0) AS failed
FROM (
    SELECT job_id, replaceAll(invoking_file, '.', '/') AS f, failure_count, error_count
    FROM tests.all_test_runs
    WHERE job_id IN {{job_ids: Array(Int64)}}
        AND time_inserted >= {{start: DateTime}} AND time_inserted < {{stop: DateTime}}
)
GROUP BY job_id
{SETTINGS}
"""


def fetch_e2(start: datetime, stop: datetime) -> list[E2Event]:
    """PR-specific first failures per (PR, file) in the window."""
    params = {
        "start": sql_time(start),
        "stop": sql_time(stop),
        "main_window": events.MAIN_WINDOW_SECONDS,
        "look_back_days": PR_LOOK_BACK_DAYS,
    }
    return events.parse_e2(ch("e2", E2_SQL, params))


Reports = dict[int, tuple[set[str], set[str]]]


def ran_files(jobs: dict[int, tuple[int, int]]) -> Reports:
    """Per job, given its run id and roughly when it ran (unix seconds), the test files
    in its reports and those of them with a failed case; jobs without a report are
    absent."""
    ran: Reports = {}
    for batch in batched(sorted(jobs)):
        params = {"run_ids": sorted({jobs[j][0] for j in batch}), "job_ids": batch}
        for r in ch("ran_files", RAN_FILES, params):
            ran[int(r["job_id"])] = (set(r["ran"]), set(r["failed"]))
    missing = sorted((j for j in jobs if j not in ran), key=lambda j: jobs[j][1])
    for batch in batched(missing, RAN_BATCH):
        seen = [jobs[j][1] for j in batch]
        window = {
            "job_ids": sorted(batch),
            "start": sql_time(min(seen) - 2 * DAY),
            "stop": sql_time(max(seen) + 5 * DAY),
        }
        for r in ch("ran_files_all", RAN_FILES_ALL, window):
            ran[int(r["job_id"])] = (set(r["ran"]), set(r["failed"]))
    return ran
