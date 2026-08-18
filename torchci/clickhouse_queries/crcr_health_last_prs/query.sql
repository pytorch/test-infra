WITH recent_prs AS (
    SELECT pr_number
    FROM default.crcr_workflow_job FINAL
    WHERE
        downstream_repo = 'pytorch/crcr-test'
        AND status = 'completed'
        AND pr_number > 0
    GROUP BY pr_number
    ORDER BY max(started_at) DESC
    LIMIT {count: UInt64}
)
SELECT
    pr_number,
    max(started_at) AS last_run,
    countIf(
        conclusion = 'success'
        OR (job_name LIKE '%xfail%' AND conclusion = 'failure')
        OR (job_name LIKE '%xcancel%' AND conclusion = 'cancelled')
        OR (job_name LIKE '%xtimeout%' AND conclusion = 'timed_out')
    ) AS successes,
    count() AS total,
    if(total > 0, successes / total, 0) AS pass_rate
FROM
    (
        SELECT
            pr_number,
            job_name,
            started_at,
            conclusion,
            ROW_NUMBER() OVER (
                PARTITION BY pr_number, job_name
                ORDER BY run_attempt DESC
            ) AS rn
        FROM
            default.crcr_workflow_job FINAL
        WHERE
            downstream_repo = 'pytorch/crcr-test'
            AND status = 'completed'
            AND pr_number > 0
            AND pr_number IN (SELECT pr_number FROM recent_prs)
    )
WHERE
    rn = 1
GROUP BY
    pr_number
ORDER BY
    last_run DESC
