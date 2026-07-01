SELECT
    upstream_repo,
    pr_number,
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
    AND pr_number IN (
        SELECT pr_number
        FROM default.crcr_workflow_job FINAL
        WHERE
            downstream_repo = {repo: String}
            AND started_at > now() - INTERVAL {days: UInt64} DAY
        GROUP BY pr_number
        ORDER BY max(started_at) DESC
        LIMIT
            {per_page: UInt64}
            OFFSET {offset: UInt64}
    )
ORDER BY
    started_at DESC
