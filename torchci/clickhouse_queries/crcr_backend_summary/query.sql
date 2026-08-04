SELECT
    countIf(conclusion = 'success') AS successes,
    countIf(conclusion = 'failure') AS failures,
    countIf(conclusion = 'timed_out') AS timed_out,
    count() AS total_jobs,
    if(total_jobs > 0, successes / total_jobs, 0) AS pass_rate,
    uniqExact(pr_number) AS total_prs,
    avg(queue_time) AS avg_queue_time_s,
    avg(execution_time) AS avg_exec_time_s,
    if(
        total_jobs > 0,
        timed_out / total_jobs,
        0
    ) AS timeout_rate
FROM
    default.crcr_workflow_job FINAL
WHERE
    downstream_repo = {repo: String}
    AND started_at > now() - INTERVAL {days: UInt64} DAY
    AND status = 'completed'
    AND pr_number > 0
