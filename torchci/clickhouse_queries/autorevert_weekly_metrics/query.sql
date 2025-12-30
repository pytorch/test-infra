-- Weekly Autorevert Metrics Query
-- Aggregates signal recovery and revert data by week for trend analysis
-- Computes key metrics: total recoveries, autorevert rate, human revert rate

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

signal_with_streaks AS (
    SELECT
        base_name,
        workflow_name,
        sha,
        time,
        message,
        status,
        if(status != lagInFrame(status, 1, status) OVER w, 1, 0) AS is_change
    FROM signal_status
    WHERE status IN ('red', 'green')
    WINDOW w AS (
        PARTITION BY base_name
        ORDER BY time ASC
    )
),

signal_with_streak_ids AS (
    SELECT
        *,
        sum(is_change) OVER (
            PARTITION BY base_name
            ORDER BY time ASC ROWS UNBOUNDED PRECEDING
        ) AS streak_id
    FROM signal_with_streaks
),

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
),

-- Get autorevert events for attribution
autorevert_events AS (
    SELECT
        toString(commit_sha) AS reverted_sha,
        ts AS autorevert_time,
        source_signal_keys
    FROM misc.autorevert_events_v2 FINAL
    WHERE
        repo = 'pytorch/pytorch'
        AND action = 'revert'
        AND dry_run = 0
        AND failed = 0
        AND ts >= toDateTime({startTime: DateTime64(3)}) - INTERVAL 1 DAY
        AND ts < toDateTime({stopTime: DateTime64(3)}) + INTERVAL 1 DAY
),

-- Extract reverted commit SHA from recovery message
recovery_with_reverted_sha AS (
    SELECT
        r.*,
        (
            r.recovery_message LIKE 'Revert %'
            OR r.recovery_message LIKE 'Reapply %'
            OR r.recovery_message LIKE 'Back out%'
        ) AS is_revert,
        -- Extract the actual reverted commit SHA from message (e.g., "This reverts commit abc123...")
        -- The regex captures the full 40-char SHA since commit messages include full SHAs
        arrayElement(
            extractAll(r.recovery_message, 'reverts commit ([a-f0-9]+)'), 1
        ) AS reverted_commit_sha
    FROM recovery_events r
),

-- Join with autorevert events on full SHA match
recovery_with_attribution AS (
    SELECT
        r.signal_key,
        r.red_streak_length,
        r.green_streak_length,
        r.recovery_sha,
        r.recovery_time,
        r.recovery_message,
        r.last_red_sha,
        r.last_red_time,
        r.is_revert,
        r.reverted_commit_sha,
        -- Check for autorevert attribution by matching the reverted commit SHA
        a.reverted_sha IS NOT NULL AND a.reverted_sha != '' AS is_autorevert
    FROM recovery_with_reverted_sha r
    LEFT JOIN autorevert_events a ON r.reverted_commit_sha = a.reverted_sha
),

-- Deduplicate by recovery_sha to count unique revert commits
-- A single revert can fix multiple signals, but we count it as one revert event
unique_recoveries AS (
    SELECT
        recovery_sha,
        any(recovery_time) AS recovery_time,
        max(is_revert) AS is_revert,
        max(is_autorevert) AS is_autorevert
    FROM recovery_with_attribution
    GROUP BY recovery_sha
)

-- Aggregate by week
SELECT
    toString(toStartOfWeek(recovery_time, 1)) AS week,
    -- Total signal recovery events (where recovery was via revert)
    countIf(is_revert) AS total_revert_recoveries,
    -- Autorevert-triggered recoveries (True Positives)
    countIf(is_revert AND is_autorevert) AS autorevert_recoveries,
    -- Human-initiated revert recoveries (potential False Negatives - should have been autoreverted)
    countIf(is_revert AND NOT is_autorevert) AS human_revert_recoveries,
    -- All signal recoveries (including non-revert like fixes)
    count() AS total_signal_recoveries,
    -- Non-revert recoveries (signal fixed by new commit, not a revert)
    countIf(NOT is_revert) AS non_revert_recoveries,
    -- Metrics (rounded for display)
    round(if(
        countIf(is_revert) > 0,
        countIf(is_revert AND is_autorevert) * 100.0 / countIf(is_revert),
        0
    ), 1) AS autorevert_rate,
    round(if(
        countIf(is_revert) > 0,
        countIf(is_revert AND NOT is_autorevert) * 100.0 / countIf(is_revert),
        0
    ), 1) AS human_revert_rate
FROM unique_recoveries
GROUP BY week
ORDER BY week ASC
