"""The scorer's own ClickHouse queries: the ones torchci.td.labels.queries does not
have. Every value is a bound parameter and every query is read-only and capped
(the labels' SETTINGS)."""

from torchci.td.labels.queries import JOBS_AT_HEADS, SETTINGS
from torchci.td.llm.events_sql import METRIC_FILTER


# torchci.td.historical_file_failure_correlation.FAILED_TESTS_QUERY, the failure
# history file_test_rating.json is generated from, with its 90 days up to now replaced
# by the window [start, stop): failing test files of td_test_failure_stats_v2 rows with
# the head sha of their run and the earliest failure time per (head sha, file).
FAIL_HISTORY = f"""
WITH metrics AS (
    SELECT run_id, timestamp, JSONExtractString(info, 'failure') AS failure
    FROM misc.ossci_uploaded_metrics
    WHERE metric_name = 'td_test_failure_stats_v2'
        AND timestamp >= {{start: DateTime}} AND timestamp < {{stop: DateTime}}
)
SELECT w.head_sha AS head_sha, m.failure AS failure,
    toUnixTimestamp(min(m.timestamp)) AS ts
FROM metrics AS m
INNER JOIN (
    SELECT id, head_sha FROM default.workflow_run
    WHERE created_at > {{start: DateTime}} - INTERVAL 10 DAY
        AND id IN (SELECT run_id FROM metrics)
) AS w ON m.run_id = w.id
GROUP BY head_sha, failure
{SETTINGS}
"""

MERGE_BASES = f"""
SELECT sha, any(merge_base) AS merge_base, any(changed_files) AS changed_files
FROM default.merge_bases
WHERE repo IN ('', 'pytorch/pytorch') AND sha IN {{shas: Array(String)}}
GROUP BY sha
{SETTINGS}
"""

PR_META = f"""
SELECT number, any(body) AS body, any(base.sha) AS base_sha, any(base.ref) AS base_ref
FROM default.pull_request FINAL
WHERE number IN {{numbers: Array(Int64)}} AND dynamoKey LIKE 'pytorch/pytorch/%'
GROUP BY number
{SETTINGS}
"""

ISSUE_TEXT = f"""
SELECT number, any(body) AS body
FROM default.issues FINAL
WHERE number IN {{numbers: Array(Int64)}} AND dynamoKey LIKE 'pytorch/pytorch/%'
GROUP BY number
{SETTINGS}
"""

# When each workflow run at the given heads started: its first job's creation, over
# every attempt (a re-run attempt reuses the first attempt's TD results).
HEAD_RUNS = f"""
SELECT head_sha, workflow_name AS workflow, run_id,
    toUnixTimestamp(min(created_at)) AS started
FROM default.workflow_job {JOBS_AT_HEADS}
GROUP BY head_sha, workflow, run_id
{SETTINGS}
"""

# PreviouslyFailedInPR reads the pytest cache of the PR's workflow, which only failed
# (not cancelled) test jobs of the {cached} build environments upload
# (history.CACHED_ENVS): per (PR, workflow, head sha, file), the first
# td_test_failure_stats_v2 failure of such a job.
# PRs of ciflow tag runs come from the tag, as in torchci.td.llm's E2 query.
PR_FAILURES = f"""
WITH
    metric_rows AS (
        SELECT pr_number, run_id, job_id, workflow, timestamp,
            JSONExtractString(info, 'test_name') AS test_file
        FROM misc.ossci_uploaded_metrics
        WHERE {METRIC_FILTER} AND timestamp >= {{start: DateTime64(3)}}
            AND timestamp < {{stop: DateTime64(3)}}
            AND multiSearchAny(build_environment, {{cached: Array(String)}})
    ),
    runs AS (
        SELECT id, head_sha, head_branch FROM default.workflow_run
        WHERE id IN (SELECT run_id FROM metric_rows) LIMIT 1 BY id
    ),
    failed_jobs AS (
        SELECT id FROM default.workflow_job FINAL
        WHERE id IN (SELECT job_id FROM metric_rows) AND conclusion = 'failure'
    )
SELECT if(m.pr_number > 0, m.pr_number,
        toInt64OrZero(extract(w.head_branch, '^ciflow/[^/]+/(\\\\d+)$'))) AS pr,
    m.workflow AS workflow, w.head_sha AS head_sha, m.test_file AS test_file,
    toUnixTimestamp(min(m.timestamp)) AS ts
FROM metric_rows AS m LEFT JOIN runs AS w ON w.id = m.run_id
WHERE pr > 0 AND m.job_id IN (SELECT id FROM failed_jobs)
GROUP BY pr, workflow, head_sha, test_file
{SETTINGS}
"""
