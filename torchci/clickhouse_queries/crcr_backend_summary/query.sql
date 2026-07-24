SELECT
    countIf(conclusion = 'success') AS successes,
    countIf(conclusion = 'failure') AS failures,
    countIf(conclusion = 'timed_out') AS timed_out,
    count() AS total_jobs,
    if(total_jobs > 0, successes / total_jobs, 0) AS pass_rate,
    uniqExact(pr_number) AS total_prs,
    avg(queue_time) AS avg_queue_time_s,
    avg(execution_time) AS avg_exec_time_s,
    -- Flaky: jobs where the same job_name has both success and failure
    -- across different run_attempts for the same PR
    uniqExactIf(
        job_name,
        job_name IN (
            SELECT job_name
            FROM default.crcr_workflow_job FINAL
            WHERE
                downstream_repo = {repo: String}
                AND started_at > now() - INTERVAL {days: UInt64} DAY
                AND status = 'completed'
                AND pr_number > 0
            GROUP BY pr_number, job_name
            HAVING
                countIf(conclusion = 'success') > 0
                AND countIf(conclusion = 'failure') > 0
        )
    ) AS flaky_jobs
FROM
    default.crcr_workflow_job FINAL
WHERE
    downstream_repo = {repo: String}
    AND started_at > now() - INTERVAL {days: UInt64} DAY
    AND status = 'completed'
    AND pr_number > 0
