-- All-repo variant of crcr_backend_summary for the L3 readiness panel and
-- the /crcr at-a-glance readiness column. `days` here is the L3 evaluation
-- window (promotion/demotion) chosen by that panel — deliberately not the
-- page's Time Range selector, so the verdict doesn't change depending on
-- which dropdown value a reviewer happened to have.
WITH deduped AS (
    SELECT
        downstream_repo,
        pr_number,
        job_name,
        conclusion,
        queue_time,
        execution_time,
        run_id,
        started_at,
        completed_at,
        ROW_NUMBER() OVER (
            PARTITION BY downstream_repo, run_id, job_name
            ORDER BY run_attempt DESC
        ) AS rn
    FROM
        default.crcr_workflow_job FINAL
    WHERE
        started_at > now() - INTERVAL {days: UInt64} DAY
        AND status = 'completed'
        AND pr_number > 0
),

base AS (
    SELECT
        downstream_repo,
        conclusion,
        job_name,
        pr_number,
        queue_time,
        execution_time,
        -- Partition by (downstream_repo, run_id): run_id (github.run_id) is
        -- only unique within a single downstream repo, and this query spans
        -- all repos (unlike crcr_backend_summary, which filters to one).
        max(queue_time) OVER (PARTITION BY downstream_repo, run_id) AS run_queue_time_s,
        dateDiff(
            'second',
            min(started_at) OVER (PARTITION BY downstream_repo, run_id),
            max(completed_at) OVER (PARTITION BY downstream_repo, run_id)
        ) AS run_span_s,
        row_number() OVER (
            PARTITION BY downstream_repo, run_id ORDER BY job_name
        ) AS run_rn
    FROM deduped
    WHERE rn = 1
)

SELECT
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
        conclusion = 'timed_out'
        AND NOT (
            downstream_repo = 'pytorch/crcr-test'
            AND job_name LIKE '%xtimeout%'
            AND conclusion = 'timed_out'
        )
    ) AS timed_out,
    count() AS total_jobs,
    if(total_jobs > 0, successes / total_jobs, 0) AS pass_rate,
    avg(queue_time) AS avg_queue_time_s,
    max(execution_time) AS max_exec_time_s,
    -- E2E time is per-run; run_rn = 1 keeps one sample per run.
    quantileExactIf(0.5)(
        run_queue_time_s + run_span_s,
        run_rn = 1 AND run_queue_time_s IS NOT NULL
    ) AS median_e2e_time_s,
    if(
        total_jobs > 0,
        timed_out / total_jobs,
        0
    ) AS timeout_rate
FROM base
GROUP BY
    repo
