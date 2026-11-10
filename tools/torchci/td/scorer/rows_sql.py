"""The ClickHouse queries of a day shard (shards.py runs them).

Every query is read-only (`readonly = 2`) and bounded in time and threads; values are
bound as parameters, never interpolated.
"""

from torchci.td.llm.events_sql import TD_SCOPE


SETTINGS = "SETTINGS readonly = 2, max_execution_time = 600, max_threads = 8"
# get_job_base_name's split, as run_test.py keys test times and TD names a job.
JOB_SPLIT = "splitByRegexp(' / test(?:-osdc)? \\\\(', name)"
JOB_COLUMNS = (
    f"{JOB_SPLIT} AS np, np[1] AS build_env,"
    " splitByString(', ', trimRight(np[2], ')'))[1] AS test_config"
)
# `expected` rows are not a test file.
NOT_A_FILE = ("", "expected")
IS_FILE = f"invoking_file NOT IN {NOT_A_FILE!r}"
FAILED_CASE = "(failure_count > 0 OR error_count > 0)"
REAL_FAILURE = f"{FAILED_CASE} AND {IS_FILE}"
# A pytorch/pytorch TD job, read at its latest row (ORDER BY _inserted_at DESC LIMIT 1 BY
# id), then kept when TD_JOB_SUCCESS holds.
TD_JOB_FILTER = (
    "startsWith(name, 'before-test / target-determination')"
    " AND startsWith(dynamoKey, 'pytorch/pytorch/')"
)
TD_JOB_SUCCESS = f"status = 'completed' AND conclusion = 'success' AND {TD_SCOPE}"

# The PR of workflow run `r` (event, head_branch, pull_requests) given `s`, its head's
# pr_by_sha row; 0 for none.
PR_OF_RUN = """multiIf(
        r.event = 'push' AND match(r.head_branch, '^ciflow/[^/]+/\\\\d+$'),
            toInt64OrZero(extract(r.head_branch, '^ciflow/[^/]+/(\\\\d+)$')),
        r.event != 'pull_request', 0,
        notEmpty(r.pull_requests), tupleElement(r.pull_requests[1], 'number'),
        ifNull(s.number, 0)
    )"""

RUNS_SQL = f"""
WITH
    td AS (
        SELECT run_id, max(id) AS td_job_id, min(created_at) AS td_created_at
        FROM (
            SELECT id, run_id, created_at, workflow_name AS workflow, status, conclusion
            FROM default.workflow_job
            PREWHERE id IN (
                SELECT id FROM materialized_views.workflow_job_by_created_at
                WHERE created_at >= {{start: DateTime64(3)}}
                    AND created_at < {{stop: DateTime64(3)}}
            )
            WHERE {TD_JOB_FILTER}
            ORDER BY _inserted_at DESC
            LIMIT 1 BY id
        )
        WHERE {TD_JOB_SUCCESS}
        GROUP BY run_id
    ),
    runs AS (
        SELECT id, head_sha, head_branch, pull_requests, run_attempt, event
        FROM default.workflow_run
        WHERE id IN (SELECT run_id FROM td) AND repository.full_name = 'pytorch/pytorch'
        ORDER BY run_attempt DESC
        LIMIT 1 BY id
    ),
    by_sha AS (
        SELECT head_sha, max(number) AS number FROM materialized_views.pr_by_sha
        WHERE head_sha IN (SELECT head_sha FROM runs) GROUP BY head_sha
    )
SELECT
    t.run_id AS run_id, t.td_job_id AS td_job_id,
    t.td_created_at AS created_at, r.head_sha AS head_sha, r.run_attempt AS attempts,
    {PR_OF_RUN} AS pr
FROM td AS t
INNER JOIN runs AS r ON r.id = t.run_id
LEFT JOIN by_sha AS s ON s.head_sha = r.head_sha
WHERE pr > 0
ORDER BY run_id
{SETTINGS}
"""


# Per (job, run, file) of tests.all_test_runs, one row per test case: `bad` is any
# failure, reruns included; `real_failure` one that is not rerun-only.
OUTCOMES = f"""outcomes AS (
        SELECT job_id, workflow_id, replaceAll(invoking_file, '.', '/') AS test_file,
            max({FAILED_CASE} OR rerun_count > 0) AS bad,
            max({FAILED_CASE}) AS real_failure
        FROM tests.all_test_runs
        WHERE workflow_id IN {{runs: Array(Int64)}} AND job_id IN (SELECT id FROM jobs)
            AND {IS_FILE}
        GROUP BY job_id, workflow_id, test_file
    )"""


def units_sql(job_failed: str = "j.conclusion = 'failure'") -> str:
    """Per (run, build env, test config): the files that ran, failed and are neither, as
    shards.py defines them, from OUTCOMES joined to the job `j` on both ids;
    `job_failed` says whether job `j` failed."""
    return f"""
WITH
    jobs AS (
        SELECT id, run_id, run_attempt, conclusion, {JOB_COLUMNS}
        FROM default.workflow_job
        PREWHERE id IN (
            SELECT id FROM materialized_views.workflow_job_by_head_sha
            WHERE head_sha IN {{shas: Array(String)}}
        )
        WHERE run_id IN {{runs: Array(Int64)}} AND length(np) = 2
        ORDER BY _inserted_at DESC
        LIMIT 1 BY id
    ),
    {OUTCOMES},
    job_files AS (
        SELECT j.id AS job_id, j.run_id AS run_id, j.run_attempt AS attempt,
            j.build_env AS build_env, j.test_config AS test_config,
            {job_failed} AS job_failed, o.test_file AS test_file,
            o.bad AS bad, o.real_failure AS real_failure
        FROM outcomes AS o
        INNER JOIN jobs AS j ON j.id = o.job_id AND j.run_id = o.workflow_id
    ),
    job_failing AS (
        SELECT job_id, countIf(real_failure) AS failing FROM job_files GROUP BY job_id
    ),
    per_attempt AS (
        SELECT f.run_id AS run_id, f.build_env AS build_env, f.test_config AS test_config,
            f.test_file AS test_file, f.attempt AS attempt,
            max(f.bad OR f.real_failure) AS bad,
            max(f.real_failure AND f.job_failed AND c.failing <= {{max_failing: UInt32}})
                AS counted
        FROM job_files AS f
        INNER JOIN job_failing AS c ON c.job_id = f.job_id
        GROUP BY run_id, build_env, test_config, test_file, attempt
    ),
    per_file AS (
        SELECT run_id, build_env, test_config, test_file, max(bad) AS ever_bad,
            argMax(counted, attempt) AS last_counted
        FROM per_attempt
        GROUP BY run_id, build_env, test_config, test_file
    )
SELECT run_id, build_env, test_config, arraySort(groupArray(test_file)) AS ran,
    arraySort(groupArrayIf(test_file, last_counted)) AS failed,
    arraySort(groupArrayIf(test_file, ever_bad AND NOT last_counted)) AS neither
FROM per_file
GROUP BY run_id, build_env, test_config
ORDER BY run_id, build_env, test_config
{SETTINGS}
"""


UNITS_SQL = units_sql()

# head_branch 'main' alone also matches fork PR runs from a branch named main.
MAIN_FAILURES_SQL = f"""
WITH
    candidates AS (
        SELECT id, run_id, workflow_name AS workflow, {JOB_COLUMNS}
        FROM default.workflow_job
        PREWHERE id IN (
            SELECT id FROM materialized_views.workflow_job_by_created_at
            WHERE created_at >= {{start: DateTime64(3)}}
                AND created_at < {{stop: DateTime64(3)}}
        )
        WHERE head_branch = 'main' AND length(np) = 2
            AND startsWith(dynamoKey, 'pytorch/pytorch/') AND {TD_SCOPE}
        ORDER BY _inserted_at DESC
        LIMIT 1 BY id
    ),
    jobs AS (
        SELECT * FROM candidates
        WHERE run_id IN (
            SELECT id FROM default.workflow_run
            WHERE id IN (SELECT run_id FROM candidates) AND head_branch = 'main'
                AND event IN ('push', 'schedule')
                AND repository.full_name = 'pytorch/pytorch'
        )
    )
SELECT DISTINCT j.build_env AS build_env, j.test_config AS test_config,
    replaceAll(f.invoking_file, '.', '/') AS test_file
FROM tests.all_test_runs AS f
INNER JOIN jobs AS j ON j.id = f.job_id AND j.run_id = f.workflow_id
WHERE f.job_id IN (SELECT id FROM jobs) AND {REAL_FAILURE}
{SETTINGS}
"""
