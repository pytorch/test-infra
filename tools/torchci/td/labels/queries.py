"""The label builder's ClickHouse queries and the fetches the unit kinds share. Every
value is a bound parameter and every query is read-only and capped in time, threads and
result size."""

import logging
import time
from typing import Any, Iterable

from torchci.td.llm import events
from torchci.td.llm.events_sql import SETTINGS as LLM_SETTINGS


logger = logging.getLogger(__name__)

BATCH = 500
LARGE_BATCH = 2000
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
