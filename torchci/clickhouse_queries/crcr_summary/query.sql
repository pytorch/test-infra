SELECT
    downstream_repo AS repo,
    anyLast(downstream_repo_level) AS downstream_repo_level,
    countIf(conclusion = 'success') AS successes,
    countIf(conclusion = 'failure') AS failures,
    countIf(conclusion = 'timed_out') AS timed_out,
    count() AS total,
    if(total > 0, successes / total, 0) AS pass_rate,
    avg(duration_seconds) AS avg_duration_s,
    max(started_at) AS last_run
FROM
    default.crcr_workflow_job FINAL
WHERE
    started_at > now() - INTERVAL {days: UInt64} DAY
    AND status = 'completed'
    AND pr_number > 0
GROUP BY
    repo
ORDER BY
    pass_rate ASC
