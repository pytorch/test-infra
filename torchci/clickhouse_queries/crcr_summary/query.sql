WITH deduped AS (
    SELECT
        downstream_repo,
        downstream_repo_level,
        job_name,
        conclusion,
        duration_seconds,
        started_at,
        ROW_NUMBER() OVER (
            PARTITION BY downstream_repo, pr_number, job_name
            ORDER BY run_attempt DESC
        ) AS rn
    FROM
        default.crcr_workflow_job FINAL
    WHERE
        started_at > now() - INTERVAL {days: UInt64} DAY
        AND status = 'completed'
        AND pr_number > 0
)

SELECT
    downstream_repo AS repo,
    anyLast(downstream_repo_level) AS downstream_repo_level,
    countIf(
        conclusion = 'success'
        OR (
            downstream_repo = 'pytorch/crcr-test'
            AND (
                (job_name LIKE '%xfail%' AND conclusion = 'failure')
                OR (job_name LIKE '%xcancel%' AND conclusion = 'cancelled')
                OR (job_name LIKE '%xtimeout%' AND conclusion = 'timed_out')
            )
        )
    ) AS successes,
    countIf(
        conclusion = 'failure'
        AND NOT (
            downstream_repo = 'pytorch/crcr-test'
            AND job_name LIKE '%xfail%'
            AND conclusion = 'failure'
        )
    ) AS failures,
    countIf(
        conclusion = 'timed_out'
        AND NOT (
            downstream_repo = 'pytorch/crcr-test'
            AND job_name LIKE '%xtimeout%'
            AND conclusion = 'timed_out'
        )
    ) AS timed_out,
    count() AS total,
    if(total > 0, successes / total, 0) AS pass_rate,
    avg(duration_seconds) AS avg_duration_s,
    max(started_at) AS last_run
FROM
    deduped
WHERE
    rn = 1
GROUP BY
    repo
ORDER BY
    pass_rate ASC
