-- Select complete matrix rows before returning their individual jobs. A raw
-- job limit could otherwise cut a many-job nightly in half. The range is
-- qualified by a completed job, then all siblings of the selected SHA/run are
-- returned so an in-progress or older-completed sibling is not lost.
WITH nightly_jobs AS (
    SELECT
        *,
        -- An ALIAS column, which SELECT * leaves out.
        duration_seconds,
        if(
            match(pytorch_head_sha, '^[0-9a-fA-F]{40}$'),
            concat('sha:', pytorch_head_sha),
            concat('run:', if(run_id != '', run_id, pytorch_head_sha))
        ) AS matrix_key
    FROM default.crcr_workflow_job FINAL
    WHERE
        downstream_repo = {repo: String}
        AND event_type = 'nightly'
),

eligible_matrix_keys AS (
    SELECT matrix_key
    FROM (
        SELECT
            matrix_key,
            max(started_at) AS latest_started_at
        FROM nightly_jobs
        WHERE
            status = 'completed'
            AND completed_at >= now() - INTERVAL {days: UInt64} DAY
            AND completed_at < now()
        GROUP BY matrix_key
    )
    ORDER BY latest_started_at DESC, matrix_key DESC
    LIMIT {limit: UInt64} OFFSET {offset: UInt64}
),

latest_attempts AS (
    SELECT
        matrix_key,
        run_id,
        job_name,
        max(run_attempt) AS max_attempt
    FROM nightly_jobs
    WHERE matrix_key IN (SELECT matrix_key FROM eligible_matrix_keys)
    GROUP BY matrix_key, run_id, job_name
)

SELECT
    upstream_repo,
    pytorch_head_sha,
    workflow_name,
    job_name,
    check_run_id,
    run_id,
    run_attempt,
    status,
    conclusion,
    started_at,
    completed_at,
    duration_seconds,
    total_tests,
    passed_tests,
    failed_tests,
    skipped_tests,
    workflow_run_url,
    artifact_url,
    queue_time,
    execution_time,
    failed_tests_json
FROM
    nightly_jobs
WHERE
    (matrix_key, run_id, job_name, run_attempt) IN (
        SELECT
            matrix_key,
            run_id,
            job_name,
            max_attempt
        FROM latest_attempts
    )
ORDER BY
    started_at DESC
