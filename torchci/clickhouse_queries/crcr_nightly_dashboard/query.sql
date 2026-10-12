-- Select complete matrix rows before returning their individual jobs. A raw
-- job limit could otherwise cut a many-job nightly in half.
WITH nightly_jobs AS (
    SELECT
        *,
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
    SELECT DISTINCT matrix_key
    FROM nightly_jobs
    WHERE started_at > now() - INTERVAL {days: UInt64} DAY
),

selected_matrix_keys AS (
    SELECT matrix_key
    FROM nightly_jobs
    WHERE matrix_key IN (SELECT matrix_key FROM eligible_matrix_keys)
    GROUP BY matrix_key
    ORDER BY max(started_at) DESC
    LIMIT {limit: UInt64} OFFSET {offset: UInt64}
),

latest_attempts AS (
    SELECT
        run_id,
        job_name,
        max(run_attempt) AS max_attempt
    FROM nightly_jobs
    WHERE matrix_key IN (SELECT matrix_key FROM selected_matrix_keys)
    GROUP BY run_id, job_name
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
    matrix_key IN (SELECT matrix_key FROM selected_matrix_keys)
    AND (run_id, job_name, run_attempt) IN (
        SELECT
            run_id,
            job_name,
            max_attempt
        FROM latest_attempts
    )
ORDER BY
    started_at DESC
