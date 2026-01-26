-- Signal Recovery Detection Query
-- Finds instances where a signal (job group) recovers: 2+ red commits followed by 2+ green commits
-- Used for autorevert metrics to identify significant recovery events

WITH commits AS (
    SELECT
        push.head_commit.'timestamp' AS time,
        push.head_commit.'id' AS sha,
        push.head_commit.'message' AS message
    FROM push
    WHERE
        push.ref IN ('refs/heads/master', 'refs/heads/main')
        AND push.repository.'owner'.'name' = 'pytorch'
        AND push.repository.'name' = 'pytorch'
        AND push.head_commit.'timestamp' >= {startTime: DateTime64(3)}
        AND push.head_commit.'timestamp' < {stopTime: DateTime64(3)}
),

all_runs AS (
    SELECT
        workflow_run.id AS id,
        workflow_run.head_commit.'id' AS sha,
        workflow_run.name AS workflow_name,
        commit.time AS time,
        commit.message AS message
    FROM workflow_run FINAL
    JOIN commits commit ON workflow_run.head_commit.'id' = commit.sha
    WHERE
        workflow_run.name IN ({workflowNames: Array(String)})
        AND workflow_run.event != 'workflow_run'
        AND workflow_run.id IN (
            SELECT id FROM materialized_views.workflow_run_by_head_sha
            WHERE head_sha IN (SELECT sha FROM commits)
        )
),

all_jobs AS (
    SELECT
        all_runs.time AS time,
        all_runs.sha AS sha,
        all_runs.message AS message,
        all_runs.workflow_name AS workflow_name,
        job.run_attempt AS run_attempt,
        job.conclusion AS raw_conclusion,
        -- Normalize job name to group shards together (same as auto-revert logic)
        trim(
            replaceRegexpAll(
                replaceRegexpAll(
                    replaceRegexpAll(job.name, '\\s*\\(.*\\)$', ''),
                    ', \\d+, \\d+, ', ', '
                ),
                '\\s+', ' '
            )
        ) AS base_name
    FROM default.workflow_job job FINAL
    JOIN all_runs ON all_runs.id = job.run_id
    WHERE
        job.name != 'ciflow_should_run'
        AND job.name != 'generate-test-matrix'
        AND job.name NOT LIKE '%rerun_disabled_tests%'
        AND job.name NOT LIKE '%unstable%'
        AND job.id IN (
            SELECT id FROM materialized_views.workflow_job_by_head_sha
            WHERE head_sha IN (SELECT sha FROM commits)
        )
),

-- Step 1: For each (sha, base_name, run_attempt), determine attempt status
attempt_status AS (
    SELECT
        time,
        sha,
        message,
        base_name,
        workflow_name,
        run_attempt,
        MAX(raw_conclusion IN ('failure', 'timed_out', 'cancelled'))
            AS attempt_has_failure,
        MAX(raw_conclusion = '') AS attempt_has_pending
    FROM all_jobs
    GROUP BY time, sha, message, base_name, workflow_name, run_attempt
),

-- Step 2: For each (sha, base_name), aggregate across all attempts
signal_status AS (
    SELECT
        time,
        sha,
        message,
        base_name,
        any(workflow_name) AS workflow_name,
        CASE
            WHEN MAX(attempt_has_pending) = 1 THEN 'pending'
            WHEN MIN(attempt_has_failure) = 1 THEN 'red'
            WHEN MAX(attempt_has_failure) = 1 THEN 'flaky'
            ELSE 'green'
        END AS status
    FROM attempt_status
    GROUP BY time, sha, message, base_name
),

-- Step 3: Assign streak IDs using cumulative status changes
signal_with_streaks AS (
    SELECT
        base_name,
        workflow_name,
        sha,
        time,
        message,
        status,
        -- Change marker: 1 when status differs from previous
        if(status != lagInFrame(status, 1, status) OVER w, 1, 0) AS is_change
    FROM signal_status
    WHERE status IN ('red', 'green')  -- Focus on definitive states
    WINDOW w AS (
        PARTITION BY base_name
        ORDER BY time ASC
    )
),

-- Step 4: Compute streak ID (cumulative sum of changes)
signal_with_streak_ids AS (
    SELECT
        *,
        sum(is_change)
            OVER (
                PARTITION BY base_name
                ORDER BY time ASC ROWS UNBOUNDED PRECEDING
            )
            AS streak_id
    FROM signal_with_streaks
),

-- Step 5: Count streak lengths and find boundaries
streak_lengths AS (
    SELECT
        base_name,
        streak_id,
        status,
        count(*) AS streak_length,
        min(time) AS streak_start,
        max(time) AS streak_end,
        argMin(sha, time) AS first_sha,
        argMax(sha, time) AS last_sha,
        argMin(message, time) AS first_message
    FROM signal_with_streak_ids
    GROUP BY base_name, streak_id, status
),

-- Step 6: Find recovery events: green streak that follows a red streak
recovery_events AS (
    SELECT
        green.base_name AS signal_key,
        red.streak_length AS red_streak_length,
        green.streak_length AS green_streak_length,
        green.first_sha AS recovery_sha,
        green.streak_start AS recovery_time,
        green.first_message AS recovery_message,
        red.last_sha AS last_red_sha,
        red.streak_end AS last_red_time
    FROM streak_lengths green
    JOIN streak_lengths red
        ON
            green.base_name = red.base_name
            AND green.streak_id = red.streak_id + 1
    WHERE
        green.status = 'green' AND red.status = 'red'
        AND red.streak_length >= {minRedCommits: UInt8}
        AND green.streak_length >= {minGreenCommits: UInt8}
)

-- Final output
SELECT
    signal_key,
    recovery_sha,
    recovery_time,
    recovery_message,
    last_red_sha,
    last_red_time,
    red_streak_length,
    green_streak_length,
    -- Check if recovery commit is a revert
    (
        recovery_message LIKE 'Revert %'
        OR recovery_message LIKE 'Reapply %'
        OR recovery_message LIKE 'Back out%'
    )
        AS is_revert,
    -- Extract reverted PR number if it's a revert
    extractAll(
        recovery_message,
        'Reverted https://github.com/pytorch/pytorch/pull/(\\d+)'
    ) AS reverted_pr_numbers,
    -- Extract PR number from merge commit message
    extractAll(
        recovery_message,
        'Pull Request resolved: https://github.com/pytorch/pytorch/pull/(\\d+)'
    ) AS merge_pr_numbers
FROM recovery_events
ORDER BY recovery_time DESC
