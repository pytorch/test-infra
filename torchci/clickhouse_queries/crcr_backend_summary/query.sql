WITH deduped AS (
    SELECT
        pr_number,
        job_name,
        conclusion,
        queue_time,
        execution_time,
        run_id,
        started_at,
        completed_at,
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
),

base AS (
    SELECT
        conclusion,
        job_name,
        pr_number,
        queue_time,
        execution_time,
        max(queue_time) OVER (PARTITION BY run_id) AS run_queue_time_s,
        dateDiff(
            'second',
            min(started_at) OVER (PARTITION BY run_id),
            max(completed_at) OVER (PARTITION BY run_id)
        ) AS run_span_s,
        row_number() OVER (PARTITION BY run_id ORDER BY job_name) AS run_rn
    FROM deduped
    WHERE rn = 1
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
    -- E2E time is per-run (RFC-0050); run_rn = 1 keeps one sample per run.
    medianIf(
        run_queue_time_s + run_span_s,
        run_rn = 1 AND run_queue_time_s IS NOT NULL
    ) AS median_e2e_time_s,
    quantileIf(0.95)(
        run_queue_time_s + run_span_s,
        run_rn = 1 AND run_queue_time_s IS NOT NULL
    ) AS p95_e2e_time_s,
    if(
        total_jobs > 0,
        timed_out / total_jobs,
        0
    ) AS timeout_rate
FROM base
