-- Per-commit aggregated test pass/skip/flaky/fail counts for the last N pushes
-- on a branch, restricted to a single workflow and a job-name regex.
--
-- Mirrors the per-commit table produced by skip_delta.py: the "earliest"
-- workflow_run (min id) is picked per commit so reruns don't shift the totals.
WITH anchor_time AS (
    -- If a sha is supplied, window ends at that commit's timestamp; otherwise
    -- the window ends at the latest push.
    SELECT
        if(
            {sha: String } = '',
            toDateTime64('2099-01-01 00:00:00', 3),
            (
                SELECT head_commit.'timestamp'
                FROM default.push
                WHERE repository.'full_name' = {repo: String }
                    AND ref = {ref: String }
                    AND startsWith(head_commit.'id', {sha: String })
                ORDER BY head_commit.'timestamp' DESC
                LIMIT 1
            )
        ) AS ts
),
recent_commits AS (
    SELECT
        head_commit.'id' AS sha,
        head_commit.'message' AS message,
        head_commit.'author'.'name' AS author,
        head_commit.'timestamp' AS time
    FROM default.push
    WHERE repository.'full_name' = {repo: String }
        AND ref = {ref: String }
        AND head_commit.'timestamp' <= (SELECT ts FROM anchor_time)
    ORDER BY head_commit.'timestamp' DESC
    LIMIT {count: UInt32 }
),
matched_runs AS (
    SELECT
        head_sha AS sha,
        min(id) AS workflow_id
    FROM default.workflow_run
    WHERE id IN (
        SELECT id FROM materialized_views.workflow_run_by_head_sha
        WHERE head_sha IN (SELECT sha FROM recent_commits)
    )
    AND name = {workflow: String }
    AND repository.'full_name' = {repo: String }
    GROUP BY head_sha
),
matched_jobs AS (
    SELECT
        wj.id AS job_id,
        mr.sha AS sha
    FROM default.workflow_job wj
    JOIN matched_runs mr ON wj.run_id = mr.workflow_id
    WHERE match(wj.name, {jobFilter: String })
),
test_statuses AS (
    SELECT
        mj.sha AS sha,
        invoking_file,
        atr.name AS test_name,
        classname,
        multiIf(
            countIf(
                failure_count = 0
                AND error_count = 0
                AND skipped_count = 0
                AND rerun_count = 0
            ) = count(*),
            'success',
            sum(skipped_count) > 0,
            'skipped',
            countIf(
                failure_count = 0
                AND error_count = 0
            ) > 0,
            'flaky',
            'failure'
        ) AS status
    FROM tests.all_test_runs atr
    JOIN matched_jobs mj ON mj.job_id = atr.job_id
    GROUP BY mj.sha, invoking_file, atr.name, classname
),
per_sha_counts AS (
    SELECT
        sha,
        countIf(status = 'success') AS success,
        countIf(status = 'skipped') AS skipped,
        countIf(status = 'flaky') AS flaky,
        countIf(status = 'failure') AS failure
    FROM test_statuses
    GROUP BY sha
)
SELECT
    rc.sha AS sha,
    rc.message AS message,
    rc.author AS author,
    rc.time AS time,
    mr.workflow_id AS workflow_id,
    coalesce(s.success, 0) AS success,
    coalesce(s.skipped, 0) AS skipped,
    coalesce(s.flaky, 0) AS flaky,
    coalesce(s.failure, 0) AS failure
FROM recent_commits rc
LEFT JOIN matched_runs mr ON mr.sha = rc.sha
LEFT JOIN per_sha_counts s ON s.sha = rc.sha
ORDER BY rc.time DESC
