WITH deduped AS (
    SELECT
        pr_number,
        job_name,
        conclusion,
        queue_time,
        execution_time,
        ROW_NUMBER() OVER (
            PARTITION BY run_id, job_name
            ORDER BY run_attempt DESC
        ) AS rn
    FROM
        default.crcr_workflow_job FINAL
    WHERE
        downstream_repo = {repo: String}
        AND started_at > now() - INTERVAL {days: UInt64} DAY
        AND status = 'completed'
        AND pr_number > 0
)

SELECT
    countIf(
        conclusion = 'success'
        OR (
            {repo: String} = 'pytorch/crcr-test'
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
            {repo: String} = 'pytorch/crcr-test'
            AND job_name LIKE '%xfail%'
            AND conclusion = 'failure'
        )
    ) AS failures,
    countIf(
        conclusion = 'timed_out'
        AND NOT (
            {repo: String} = 'pytorch/crcr-test'
            AND job_name LIKE '%xtimeout%'
            AND conclusion = 'timed_out'
        )
    ) AS timed_out,
    count() AS total_jobs,
    if(total_jobs > 0, successes / total_jobs, 0) AS pass_rate,
    uniqExact(pr_number) AS total_prs,
    avg(queue_time) AS avg_queue_time_s,
    avg(execution_time) AS avg_exec_time_s,
    max(execution_time) AS max_exec_time_s,
    quantile(0.95)(execution_time) AS p95_exec_time_s,
    -- End-to-end = queue_time + execution_time. RFC-0050's L3 gate defines
    -- this as the P50 (median) time-to-signal. queue_time is null
    -- on retries (dispatch-relative queue time is meaningless once a re-run
    -- reuses the original delivery_id), so it's coalesced to 0 -- a retried
    -- job's execution_time still counts toward the aggregate instead of the
    -- whole row dropping out.
    median(coalesce(queue_time, 0) + execution_time) AS median_e2e_time_s,
    quantile(0.95)(coalesce(queue_time, 0) + execution_time) AS p95_e2e_time_s,
    if(
        total_jobs > 0,
        timed_out / total_jobs,
        0
    ) AS timeout_rate
FROM
    deduped
WHERE
    rn = 1
