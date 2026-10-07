-- Retain complete runs that touched the selected window, then select the
-- final attempt for every job before calculating the summary.
WITH eligible_runs AS (
    SELECT DISTINCT run_id
    FROM default.crcr_workflow_job FINAL
    WHERE
        downstream_repo = {repo: String}
        AND started_at > now() - INTERVAL {days: UInt64} DAY
        AND event_type = 'nightly'
),

latest_attempts AS (
    SELECT
        run_id,
        job_name,
        max(run_attempt) AS max_attempt
    FROM default.crcr_workflow_job FINAL
    WHERE
        downstream_repo = {repo: String}
        AND event_type = 'nightly'
        AND run_id IN (SELECT run_id FROM eligible_runs)
    GROUP BY run_id, job_name
)

SELECT
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
    uniqExact(run_id) AS nightly_runs,
    if(total > 0, successes / total, 0) AS pass_rate
FROM default.crcr_workflow_job FINAL
WHERE
    downstream_repo = {repo: String}
    AND event_type = 'nightly'
    AND status = 'completed'
    AND (run_id, job_name, run_attempt) IN (
        SELECT run_id, job_name, max_attempt
        FROM latest_attempts
    )
