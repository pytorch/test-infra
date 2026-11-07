"""The analysis's own ClickHouse queries. Every value is a bound parameter and every
query is read-only and capped (QUERY_SETTINGS); the TD scope and the ranking columns
come from torchci.td.llm.events_sql, which follows pytorch's run_test.py."""

from torchci.td.analysis.config import QUERY_SETTINGS
from torchci.td.llm.events_sql import METRIC_FILTER, RANK_COLUMNS


MAIN_PUSHES = f"""
SELECT head_commit.id AS push_sha, before AS before_sha, repository.pushed_at AS pushed_at,
    commits.id AS commit_shas
FROM default.push FINAL
WHERE ref = 'refs/heads/main' AND repository.full_name = 'pytorch/pytorch'
    AND repository.pushed_at >= toUnixTimestamp({{start: DateTime}})
    AND repository.pushed_at < toUnixTimestamp({{stop: DateTime}})
ORDER BY pushed_at
{QUERY_SETTINGS}
"""

# pull/trunk test jobs at main pushes; the shard is the second field of the parenthesis
# in "<env> / test (<config>, <shard>, <shards>, <runner>)". From April to July 2026 many
# jobs were named "<env> / test-osdc (...)" instead.
MAIN_JOBS = f"""
SELECT head_sha AS push_sha, workflow,
    trimBoth(splitByString(' / test (', n)[1]) AS build_environment,
    trimBoth(splitByChar(',', splitByString(' / test (', n)[2])[1]) AS test_config,
    toInt32OrZero(trimBoth(splitByChar(',', splitByString(' / test (', n)[2])[2])) AS shard,
    toInt32OrZero(trimBoth(splitByChar(',', splitByString(' / test (', n)[2])[3])) AS shards,
    conclusion, completed_at, job_id
FROM (
    SELECT head_sha, workflow_name AS workflow,
        replaceOne(name, ' / test-osdc (', ' / test (') AS n,
        conclusion, toUnixTimestamp(completed_at) AS completed_at, id AS job_id
    FROM default.workflow_job FINAL
    WHERE id IN (
        SELECT id FROM materialized_views.workflow_job_by_head_sha
        WHERE head_sha IN {{shas: Array(String)}}
    ) AND workflow_name IN ('pull', 'trunk') AND head_branch = 'main'
        AND (name LIKE '% / test (%' OR name LIKE '% / test-osdc (%')
)
{QUERY_SETTINGS}
"""

# Failing test files of the given failed jobs: a case that failed or errored (a case
# that only reran and passed has neither).
FAILED_FILES = f"""
SELECT job_id, replaceAll(invoking_file, '.', '/') AS file
FROM default.failed_test_runs
WHERE job_id IN {{job_ids: Array(Int64)}}
    AND (length(failure) > 0 OR length(error) > 0)
GROUP BY job_id, file
{QUERY_SETTINGS}
"""

# The generator's failure history (historical_file_failure_correlation reads the TD
# metric, which only goes back to 2026-08-06): failing files of failed jobs of every
# pytorch/pytorch workflow, earliest failure per (head sha, file).
FAIL_HISTORY = f"""
WITH f AS (
    SELECT job_id, replaceAll(invoking_file, '.', '/') AS file, min(time_inserted) AS ts
    FROM default.failed_test_runs
    WHERE time_inserted >= {{start: DateTime}} AND time_inserted < {{stop: DateTime}}
        AND (length(failure) > 0 OR length(error) > 0) AND invoking_file != ''
    GROUP BY job_id, file
)
SELECT j.head_sha AS head_sha, f.file AS file, toUnixTimestamp(min(f.ts)) AS ts
FROM f INNER JOIN (
    SELECT id, head_sha FROM default.workflow_job
    WHERE id IN (SELECT job_id FROM f) AND conclusion = 'failure'
        AND startsWith(dynamoKey, 'pytorch/pytorch/')
) AS j ON j.id = f.job_id
GROUP BY head_sha, file
{QUERY_SETTINGS}
"""

MERGE_BASES = f"""
SELECT sha, any(merge_base) AS merge_base, any(changed_files) AS changed_files
FROM default.merge_bases
WHERE repo IN ('', 'pytorch/pytorch') AND sha IN {{shas: Array(String)}}
GROUP BY sha
{QUERY_SETTINGS}
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
{QUERY_SETTINGS}
"""

# Test jobs at the given heads (every shard of every config), for run evidence.
HEAD_JOBS = f"""
SELECT id AS job_id, head_sha,
    trimBoth(splitByString(' / test (', name)[1]) AS build_environment,
    trimBoth(splitByChar(',', splitByString(' / test (', name)[2])[1]) AS test_config,
    conclusion
FROM default.workflow_job FINAL
WHERE id IN (
    SELECT id FROM materialized_views.workflow_job_by_head_sha
    WHERE head_sha IN {{shas: Array(String)}}
) AND name LIKE '% / test (%'
{QUERY_SETTINGS}
"""

# Test files that ran in the given jobs (tests.all_test_runs is sorted by job id).
RAN_FILES = f"""
SELECT job_id, groupUniqArray(replaceAll(invoking_file, '.', '/')) AS ran
FROM tests.all_test_runs
WHERE job_id IN {{job_ids: Array(Int64)}}
    AND time_inserted >= {{start: DateTime}} AND time_inserted < {{stop: DateTime}}
GROUP BY job_id
{QUERY_SETTINGS}
"""

PR_TEXT = f"""
SELECT number, any(body) AS body, any(user.login) AS login
FROM default.pull_request FINAL
WHERE number IN {{numbers: Array(Int64)}} AND dynamoKey LIKE 'pytorch/pytorch/%'
GROUP BY number
{QUERY_SETTINGS}
"""

ISSUE_TEXT = f"""
SELECT number, any(body) AS body
FROM default.issues FINAL
WHERE number IN {{numbers: Array(Int64)}} AND dynamoKey LIKE 'pytorch/pytorch/%'
GROUP BY number
{QUERY_SETTINGS}
"""
