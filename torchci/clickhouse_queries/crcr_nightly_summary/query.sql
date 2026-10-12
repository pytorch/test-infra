-- Match the nightly dashboard: include complete runs that touch the window
-- and retain only the latest attempt for each job.
WITH eligible_runs AS (
    SELECT DISTINCT
        downstream_repo,
        run_id
    FROM default.crcr_workflow_job FINAL
    WHERE
        started_at > now() - INTERVAL {days: UInt64} DAY
        AND event_type = 'nightly'
),

latest_attempts AS (
    SELECT
        downstream_repo,
        run_id,
        job_name,
        max(run_attempt) AS max_attempt
    FROM default.crcr_workflow_job FINAL
    WHERE
        event_type = 'nightly'
        AND (downstream_repo, run_id) IN (
            SELECT
                downstream_repo,
                run_id
            FROM eligible_runs
        )
    GROUP BY downstream_repo, run_id, job_name
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
        )
    ) AS failures,
    countIf(
        conclusion = 'timed_out'
        AND NOT (
            downstream_repo = 'pytorch/crcr-test'
            AND job_name LIKE '%xtimeout%'
        )
    ) AS timed_out,
    count() AS total,
    if(total > 0, successes / total, 0) AS pass_rate,
    avg(duration_seconds) AS avg_duration_s,
    max(started_at) AS last_run,
    argMax(pytorch_head_sha, started_at) AS latest_sha
FROM default.crcr_workflow_job FINAL
WHERE
    status = 'completed'
    AND event_type = 'nightly'
    AND (downstream_repo, run_id, job_name, run_attempt) IN (
        SELECT
            downstream_repo,
            run_id,
            job_name,
            max_attempt
        FROM latest_attempts
    )
GROUP BY
    repo
ORDER BY
    pass_rate ASC
