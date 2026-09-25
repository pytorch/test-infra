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
        run_id,
        job_name,
        status,
        conclusion,
        started_at,
        ROW_NUMBER() OVER (
            PARTITION BY run_id, job_name
            ORDER BY run_attempt DESC
        ) AS rn
    FROM default.crcr_workflow_job FINAL
    WHERE
        downstream_repo = 'pytorch/crcr-test'
        AND pr_number > 0
        AND pr_number IN (SELECT pr_number FROM recent_prs)
)

SELECT
    pr_number,
    max(started_at) AS last_run,
    countIf(
        status = 'completed'
        AND (
            conclusion = 'success'
            OR (job_name LIKE '%xfail%' AND conclusion = 'failure')
            OR (job_name LIKE '%xcancel%' AND conclusion = 'cancelled')
            OR (job_name LIKE '%xtimeout%' AND conclusion = 'timed_out')
        )
    ) AS successes,
    countIf(status = 'completed') AS total,
    countIf(
        status = 'in_progress'
        AND job_name NOT LIKE '%xtimeout%'
    ) AS pending,
    countIf(
        status = 'in_progress'
        AND started_at < now() - INTERVAL {stale_after_minutes: UInt64} MINUTE
    ) AS overdue_in_progress,
    if(total > 0, successes / total, NULL) AS pass_rate
FROM latest_jobs
WHERE
    rn = 1
GROUP BY
    pr_number
ORDER BY
    last_run DESC
