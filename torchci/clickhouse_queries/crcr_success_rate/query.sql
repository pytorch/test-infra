-- Keep every final completed job from a run that touches the selected window.
-- Date the whole run by its latest selected job start, so a run that crosses
-- midnight appears in one daily point and remains inside the selected range.
WITH eligible_runs AS (
    SELECT DISTINCT
        downstream_repo,
        run_id
    FROM default.crcr_workflow_job FINAL
    WHERE
        started_at > now() - INTERVAL {days: UInt64} DAY
        AND event_type = {event_type: String}
),

latest_attempts AS (
    SELECT
        downstream_repo,
        run_id,
        job_name,
        max(run_attempt) AS max_attempt
    FROM default.crcr_workflow_job FINAL
    WHERE
        event_type = {event_type: String}
        AND (downstream_repo, run_id) IN (
            SELECT downstream_repo, run_id
            FROM eligible_runs
        )
    GROUP BY downstream_repo, run_id, job_name
),

latest_jobs AS (
    SELECT
        downstream_repo,
        run_id,
        job_name,
        conclusion,
        started_at
    FROM default.crcr_workflow_job FINAL
    WHERE
        event_type = {event_type: String}
        AND status = 'completed'
        AND (downstream_repo, run_id, job_name, run_attempt) IN (
            SELECT downstream_repo, run_id, job_name, max_attempt
            FROM latest_attempts
        )
),

run_dates AS (
    SELECT
        downstream_repo,
        run_id,
        toDate(max(started_at)) AS run_day
    FROM latest_jobs
    GROUP BY downstream_repo, run_id
)

SELECT
    run_day AS day,
    jobs.downstream_repo AS repo,
    countIf(
        jobs.conclusion = 'success'
        OR (
            jobs.downstream_repo = 'pytorch/crcr-test'
            AND (
                (jobs.job_name LIKE '%xfail%' AND jobs.conclusion = 'failure')
                OR (jobs.job_name LIKE '%xcancel%' AND jobs.conclusion = 'cancelled')
                OR (jobs.job_name LIKE '%xtimeout%' AND jobs.conclusion = 'timed_out')
            )
        )
    ) AS successes,
    countIf(
        jobs.conclusion = 'failure'
        AND NOT (
            jobs.downstream_repo = 'pytorch/crcr-test'
            AND jobs.job_name LIKE '%xfail%'
            AND jobs.conclusion = 'failure'
        )
    ) AS failures,
    countIf(
        jobs.conclusion = 'timed_out'
        AND NOT (
            jobs.downstream_repo = 'pytorch/crcr-test'
            AND jobs.job_name LIKE '%xtimeout%'
            AND jobs.conclusion = 'timed_out'
        )
    ) AS timed_out,
    count() AS total,
    if(total > 0, successes / total, 0) AS pass_rate
FROM latest_jobs AS jobs
INNER JOIN run_dates USING (downstream_repo, run_id)
GROUP BY
    run_day, jobs.downstream_repo
ORDER BY
    day ASC, repo ASC
