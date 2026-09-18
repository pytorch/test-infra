WITH
page_runs AS (
    SELECT
        invoking_file,
        time_inserted,
        job_id,
        workflow_id,
        workflow_run_attempt,
        toFloat64(time) AS duration_seconds,
        multiIf(
            failure_count > 0 OR error_count > 0, 'failure',
            skipped_count > 0, 'skipped',
            rerun_count > 0, 'flaky',
            'success'
        ) AS run_status,
        cityHash64(
            invoking_file,
            workflow_id,
            workflow_run_attempt,
            job_id,
            reinterpretAsUInt32(time),
            line,
            failure_count,
            error_count,
            skipped_count,
            rerun_count
        ) AS row_fingerprint
    FROM tests.all_test_runs_by_name
    WHERE
        file = {file: String}
        AND classname = {classname: String}
        AND name = {name: String}
        AND time_inserted > fromUnixTimestamp64Milli({cutoff_ms: Int64})
        AND time_inserted <= fromUnixTimestamp64Milli({anchor_ms: Int64})
        AND (
            {exclude_skipped: UInt8} = 0
            OR failure_count > 0
            OR error_count > 0
            OR skipped_count = 0
        )
    ORDER BY
        time_inserted DESC,
        job_id DESC,
        row_fingerprint DESC
    LIMIT
        {limit: UInt32}
        OFFSET {offset: UInt64}
),

latest_jobs AS (
    SELECT
        id,
        argMax(name, _inserted_at) AS job_name,
        argMax(workflow_name, _inserted_at) AS workflow_name,
        argMax(repository_full_name, _inserted_at) AS repository,
        argMax(html_url, _inserted_at) AS job_url,
        argMax(head_branch, _inserted_at) AS head_branch,
        argMax(head_sha, _inserted_at) AS head_sha,
        argMax(started_at, _inserted_at) AS started_at
    FROM default.workflow_job
    WHERE id IN (SELECT job_id FROM page_runs)
    GROUP BY id
)

SELECT
    t.run_status AS status,
    t.duration_seconds,
    toString(toUnixTimestamp64Nano(t.time_inserted)) AS recorded_at_ns,
    if(
        j.id = 0 OR j.started_at = toDateTime64(0, 9),
        NULL,
        toString(toUnixTimestamp64Nano(j.started_at))
    ) AS started_at_ns,
    toString(t.job_id) AS job_id,
    nullIf(j.job_name, '') AS job_name,
    nullIf(j.job_url, '') AS job_url,
    toString(t.workflow_id) AS workflow_id,
    t.workflow_run_attempt,
    nullIf(j.workflow_name, '') AS workflow_name,
    nullIf(j.repository, '') AS repository,
    nullIf(j.head_branch, '') AS head_branch,
    nullIf(j.head_sha, '') AS head_sha
FROM page_runs AS t
ANY LEFT JOIN latest_jobs AS j ON j.id = t.job_id
ORDER BY
    t.time_inserted DESC,
    t.job_id DESC,
    t.row_fingerprint DESC
