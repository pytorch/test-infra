-- Identify runs where at least one job started within the time window.
-- Using run-level filtering ensures complete nightly rows: when a pipeline's
-- jobs start at different times (build first, tests later), per-job
-- started_at filtering would clip earlier jobs from the last run, producing
-- partial rows with missing cells.
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
    upstream_repo,
    pytorch_head_sha,
    workflow_name,
    job_name,
    check_run_id,
    run_id,
    run_attempt,
    status,
    conclusion,
    started_at,
    completed_at,
    duration_seconds,
    total_tests,
    passed_tests,
    failed_tests,
    skipped_tests,
    workflow_run_url,
    artifact_url,
    queue_time,
    execution_time,
    failed_tests_json
FROM
    default.crcr_workflow_job FINAL
WHERE
    downstream_repo = {repo: String}
    AND event_type = 'nightly'
    AND run_id IN (SELECT run_id FROM eligible_runs)
    AND (run_id, job_name, run_attempt) IN (
        SELECT run_id, job_name, max_attempt FROM latest_attempts
    )
ORDER BY
    started_at DESC
LIMIT 500
