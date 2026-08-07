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
    execution_time
FROM
    default.crcr_workflow_job FINAL
WHERE
    downstream_repo = {repo: String}
    AND started_at > now() - INTERVAL {days: UInt64} DAY
    AND event_type = 'nightly'
    AND (run_id, job_name, run_attempt) IN (
        SELECT
            run_id,
            job_name,
            max(run_attempt) AS max_attempt
        FROM default.crcr_workflow_job FINAL
        WHERE
            downstream_repo = {repo: String}
            AND started_at > now() - INTERVAL {days: UInt64} DAY
            AND event_type = 'nightly'
        GROUP BY run_id, job_name
    )
ORDER BY
    started_at DESC
LIMIT 500
