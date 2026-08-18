SELECT
    toDate(started_at) AS day,
    downstream_repo AS repo,
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
    if(total > 0, successes / total, 0) AS pass_rate
FROM
    default.crcr_workflow_job FINAL
WHERE
    started_at > now() - INTERVAL {days: UInt64} DAY
    AND status = 'completed'
    AND event_type = {event_type: String}
GROUP BY
    day, repo
ORDER BY
    day ASC, repo ASC
