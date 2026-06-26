SELECT
    downstream_repo,
    workflow_name,
    job_name,
    check_run_id,
    run_id,
    run_attempt,
    status,
    conclusion,
    duration_seconds,
    workflow_run_url,
    artifact_url,
    started_at,
    queue_time,
    execution_time
FROM
    default.crcr_workflow_job FINAL
WHERE
    pr_number = {pr: UInt64}
ORDER BY
    downstream_repo, started_at DESC
LIMIT 100
