WITH recent_prs AS (
    SELECT pr_number
    FROM default.crcr_workflow_job FINAL
    WHERE
        downstream_repo = 'pytorch/crcr-test'
        AND pr_number > 0
        AND started_at >= now() - INTERVAL {window_minutes: UInt64} MINUTE
    GROUP BY pr_number
),

latest_jobs AS (
    SELECT
        pr_number,
        job_name,
        status,
        conclusion,
        started_at,
        completed_at,
        workflow_run_url,
        check_run_id,
        ROW_NUMBER() OVER (
            PARTITION BY run_id, job_name
            ORDER BY run_attempt DESC
        ) AS rn
    FROM default.crcr_workflow_job FINAL
    WHERE
        downstream_repo = 'pytorch/crcr-test'
        AND pr_number IN (SELECT pr_number FROM recent_prs)
)

SELECT
    pr_number,
    job_name,
    status,
    conclusion,
    started_at,
    completed_at,
    workflow_run_url,
    check_run_id,
    status = 'in_progress'
    AND started_at < now() - INTERVAL {stale_after_minutes: UInt64} MINUTE
        AS is_overdue
FROM latest_jobs
WHERE rn = 1
ORDER BY pr_number DESC, started_at DESC
