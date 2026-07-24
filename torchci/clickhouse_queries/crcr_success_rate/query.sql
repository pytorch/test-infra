SELECT
    toDate(started_at) AS day,
    downstream_repo AS repo,
    countIf(conclusion = 'success') AS successes,
    countIf(conclusion = 'failure') AS failures,
    countIf(conclusion = 'timed_out') AS timed_out,
    count() AS total,
    if(total > 0, successes / total, 0) AS pass_rate
FROM
    default.crcr_workflow_job FINAL
WHERE
    started_at > now() - INTERVAL {days: UInt64} DAY
    AND status = 'completed'
    AND pr_number > 0
GROUP BY
    day, repo
ORDER BY
    day ASC, repo ASC
