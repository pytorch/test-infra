-- The time range selects complete nightly rows rather than individual cells.
-- A real upstream SHA can span multiple downstream workflow runs, so once one
-- job completes in the range, return every job for that SHA. Reporters without
-- a real SHA fall back to run_id, preserving complete rows for those builds.
WITH eligible_nightly_keys AS (
    SELECT DISTINCT
        if(
            match(pytorch_head_sha, '^[0-9a-fA-F]{40}$'),
            concat('sha:', pytorch_head_sha),
            concat('run:', if(run_id != '', run_id, pytorch_head_sha))
        ) AS nightly_key
    FROM default.crcr_workflow_job FINAL
    WHERE
        downstream_repo = {repo: String}
        AND event_type = 'nightly'
        AND status = 'completed'
        AND completed_at >= now() - INTERVAL {days: UInt64} DAY
        AND completed_at < now()
),

deduped AS (
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
        failed_tests_json,
        ROW_NUMBER() OVER (
            PARTITION BY pytorch_head_sha, run_id, job_name
            ORDER BY run_attempt DESC
        ) AS rn
    FROM default.crcr_workflow_job FINAL
    WHERE
        downstream_repo = {repo: String}
        AND event_type = 'nightly'
        AND if(
            match(pytorch_head_sha, '^[0-9a-fA-F]{40}$'),
            concat('sha:', pytorch_head_sha),
            concat('run:', if(run_id != '', run_id, pytorch_head_sha))
        ) IN (SELECT nightly_key FROM eligible_nightly_keys)
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
    deduped
WHERE
    rn = 1
ORDER BY
    started_at DESC
LIMIT 500
