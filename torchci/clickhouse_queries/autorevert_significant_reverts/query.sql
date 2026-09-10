-- Significant Reverts Query
-- Finds recovery events that are reverts and attributes them to autorevert vs human
-- Used for autorevert metrics precision/recall calculations

-- The block between the @autorevert-shared-recovery-pipeline markers below is kept
-- BYTE-IDENTICAL with autorevert_weekly_metrics/query.sql. The
-- autorevertSharedPipeline test (torchci/test/autorevertSharedPipeline.test.ts)
-- fails CI if the two copies drift, so any change to the recovery-detection or
-- causal-attribution pipeline (e.g. the #8176 causal red-streak filter) MUST be
-- applied identically to BOTH files. Only each query's final aggregation, below the
-- :end marker, is allowed to differ.
-- @autorevert-shared-recovery-pipeline:begin
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

-- `push` is a ReplacingMergeTree read without FINAL, so one SHA can appear on
-- several rows. Deduplicating here rather than letting the duplicates fan out
-- through the job join removes ~0.2% spurious rows at a 90d window; the
-- downstream MAX/MIN absorbed them, so no output changes.
commit_keys AS (SELECT DISTINCT sha FROM commits),

-- Exactly one row per SHA, chosen deterministically. `DISTINCT sha, message`
-- would only make the PAIR unique, so a SHA that ever arrived with two
-- different messages would fan the joins below out instead of deduplicating
-- them. No such SHA exists over a measured 90d window, but the joins should not
-- depend on that continuing to hold.
commit_meta AS (
    SELECT
        sha,
        min(time) AS commit_time,
        argMin(message, time) AS commit_message
    FROM commits
    GROUP BY sha
),

-- Jobs are read straight from workflow_job. The workflow_run join this replaces
-- supplied `name` and `event`, both of which workflow_job carries top-level as
-- workflow_name / workflow_event -- but it ALSO acted as an existence check, so
-- a job whose run is missing from workflow_run (or from workflow_run_by_head_sha)
-- was previously excluded and now is not. That is an eligibility change, not a
-- pure refactor; no such row appeared over the window this was measured on
-- (2026-06-11 to 2026-09-09, 1,123,173 job rows, zero run/job field drift).
-- FINAL stays: without it a superseded snapshot with conclusion = '' survives
-- beside the latest row and MAX(raw_conclusion = '') below would report the
-- attempt as pending.
all_jobs AS (
    SELECT
        job.head_sha AS sha,
        job.workflow_name AS workflow_name,
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
    WHERE
        job.workflow_name IN ({workflowNames: Array(String)})
        AND job.workflow_event != 'workflow_run'
        AND job.name != 'ciflow_should_run'
        AND job.name != 'generate-test-matrix'
        AND job.name NOT LIKE '%rerun_disabled_tests%'
        AND job.name NOT LIKE '%unstable%'
        AND job.head_sha IN (SELECT sha FROM commit_keys)
        AND job.id IN (
            SELECT id FROM materialized_views.workflow_job_by_head_sha
            WHERE head_sha IN (SELECT sha FROM commit_keys)
        )
),

-- Step 1: For each (sha, base_name, run_attempt), determine attempt status.
-- Keyed on sha alone rather than (time, sha, message): both are functionally
-- determined by sha via the one-row-per-sha commit CTEs above, and grouping on
-- a full commit message across ~1.1M rows costs ~3.5x the peak memory.
attempt_status AS (
    SELECT
        sha,
        base_name,
        workflow_name,
        run_attempt,
        MAX(raw_conclusion IN ('failure', 'timed_out', 'cancelled'))
            AS attempt_has_failure,
        MAX(raw_conclusion = '') AS attempt_has_pending
    FROM all_jobs
    GROUP BY sha, base_name, workflow_name, run_attempt
),

-- Step 2: For each (sha, base_name), aggregate across all attempts
status_core AS (
    SELECT
        sha,
        base_name,
        CASE
            WHEN MAX(attempt_has_pending) = 1 THEN 'pending'
            WHEN MIN(attempt_has_failure) = 1 THEN 'red'
            WHEN MAX(attempt_has_failure) = 1 THEN 'flaky'
            ELSE 'green'
        END AS status
    FROM attempt_status
    GROUP BY sha, base_name
),

-- Commit timestamps come back here because the window functions order by them.
-- Commit MESSAGES deliberately do not: carrying them into the sort is what made
-- long ranges unservable. They are looked up once per recovery, further down.
signal_status AS (
    SELECT
        c.commit_time AS time,
        s.sha AS sha,
        s.base_name AS base_name,
        s.status AS status
    FROM status_core s
    INNER JOIN commit_meta c ON s.sha = c.sha
),

-- Step 3: Assign streak IDs using cumulative status changes
signal_with_streaks AS (
    SELECT
        base_name,
        sha,
        time,
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

-- Step 5: Count streak lengths and find boundaries.
-- `streak_shas` folds in what a separate red_streak_members CTE used to compute
-- with a second pass over signal_with_streak_ids; red rows already form their
-- own group here, so groupArray(sha) on the red side is the same array.
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
        groupArray(sha) AS streak_shas
    FROM signal_with_streak_ids
    GROUP BY base_name, streak_id, status
),

-- Step 6: Find recovery events: green streak that follows a red streak.
-- One grouped pass replaces a self-join of streak_lengths against itself.
-- Red streak k and green streak k+1 land in the same match_id group; the HAVING
-- reproduces the join's one-red-one-green pairing exactly.
recovery_pairs AS (
    SELECT
        base_name,
        if(status = 'red', streak_id + 1, streak_id) AS match_id,
        anyIf(streak_id, status = 'red') AS red_streak_id,
        anyIf(streak_length, status = 'red') AS red_streak_length,
        anyIf(streak_start, status = 'red') AS first_red_time,
        anyIf(streak_end, status = 'red') AS last_red_time,
        anyIf(first_sha, status = 'red') AS first_red_sha,
        anyIf(last_sha, status = 'red') AS last_red_sha,
        -- SHAs comprising the red streak this recovery resolves (causal filter input)
        anyIf(streak_shas, status = 'red') AS red_shas,
        anyIf(streak_length, status = 'green') AS green_streak_length,
        anyIf(first_sha, status = 'green') AS recovery_sha,
        anyIf(streak_start, status = 'green') AS recovery_time
    FROM streak_lengths
    GROUP BY base_name, match_id
    HAVING countIf(status = 'red') = 1 AND countIf(status = 'green') = 1
),

recovery_events AS (
    SELECT
        base_name AS signal_key,
        red_streak_id,
        red_streak_length,
        green_streak_length,
        recovery_sha,
        recovery_time,
        last_red_sha,
        last_red_time,
        first_red_sha,
        first_red_time,
        red_shas
    FROM recovery_pairs
    WHERE
        red_streak_length >= {minRedCommits: UInt8}
        AND green_streak_length >= {minGreenCommits: UInt8}
),

-- The commit message is attached here, per recovery, instead of being carried
-- through the aggregations and window sorts above.
recovery_with_message AS (
    SELECT
        r.*,
        m.commit_message AS recovery_message
    FROM recovery_events r
    INNER JOIN commit_meta m ON r.recovery_sha = m.sha
),

-- Step 7: Get autorevert events for attribution
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
        -- Convert DateTime64 params to DateTime for comparison
        AND ts >= toDateTime({startTime: DateTime64(3)}) - INTERVAL 1 DAY
        AND ts < toDateTime({stopTime: DateTime64(3)}) + INTERVAL 1 DAY
),

-- Step 8: Extract reverted commit SHA from recovery message
recovery_with_reverted_sha AS (
    SELECT
        r.*,
        -- Check if recovery commit is a revert
        (
            r.recovery_message LIKE 'Revert %'
            OR r.recovery_message LIKE 'Reapply %'
            OR r.recovery_message LIKE 'Back out%'
        ) AS is_revert,
        -- Extract reverted PR number if it's a revert
        extractAll(
            r.recovery_message,
            'Reverted https://github.com/pytorch/pytorch/pull/(\\d+)'
        ) AS reverted_pr_numbers,
        -- Extract PR number from merge commit message
        extractAll(
            r.recovery_message,
            'Pull Request resolved: https://github.com/pytorch/pytorch/pull/(\\d+)'
        ) AS merge_pr_numbers,
        -- Extract the actual reverted commit SHA from message (e.g., "This reverts commit abc123...")
        -- The regex captures the full 40-char SHA since commit messages include full SHAs
        arrayElement(
            extractAll(r.recovery_message, 'reverts commit ([a-f0-9]+)'), 1
        ) AS reverted_commit_sha
    FROM recovery_with_message r
),

-- Step 9: Join with autorevert events on full SHA match
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
        r.first_red_sha,
        r.first_red_time,
        r.is_revert,
        r.reverted_pr_numbers,
        r.merge_pr_numbers,
        r.reverted_commit_sha,
        r.red_shas,
        -- Check for autorevert attribution by matching the reverted commit SHA
        a.reverted_sha IS NOT NULL AND a.reverted_sha != '' AS is_autorevert,
        a.autorevert_time,
        a.source_signal_keys AS autorevert_signal_keys
    FROM recovery_with_reverted_sha r
    LEFT JOIN autorevert_events a ON r.reverted_commit_sha = a.reverted_sha
),

-- Step 10: Apply the causal-attribution filter centrally, so BOTH downstream
-- queries (autorevert_significant_reverts and autorevert_weekly_metrics) share it
-- and cannot drift. A revert only "fixes" a signal when the reverted commit is
-- actually part of the red streak that recovered; spurious recoveries -- an
-- unrelated/flaky signal that merely went red->green at the revert commit while the
-- reverted commit was never in that red streak (e.g. out-of-plane ghfirst/nosignal
-- reverts credited with a coincidental flake clear) -- are dropped. When the
-- reverted commit SHA can't be parsed from the message (Reapply / Back out shapes),
-- the row is kept unchanged.
causally_attributed_recoveries AS (
    SELECT * FROM recovery_with_attribution
    WHERE
        reverted_commit_sha = ''
        OR has(red_shas, reverted_commit_sha)
),
-- @autorevert-shared-recovery-pipeline:end

-- ===========================================================================
-- Query-specific tail: per-revert-commit detail for the precision/recall table.
-- ===========================================================================

-- Filter to only actual reverts (the causal-attribution filter is already applied
-- upstream in causally_attributed_recoveries).
reverts_only AS (
    SELECT * FROM causally_attributed_recoveries
    WHERE is_revert = 1
),

-- Aggregate by recovery_sha (one row per unique revert commit)
aggregated_reverts AS (
    SELECT
        recovery_sha,
        any(recovery_time) AS recovery_time,
        any(recovery_message) AS recovery_message,
        groupArray(signal_key) AS signal_keys,
        count() AS signals_fixed,
        any(last_red_sha) AS last_red_sha,
        any(last_red_time) AS last_red_time,
        any(first_red_sha) AS first_red_sha,
        any(first_red_time) AS first_red_time,
        max(red_streak_length) AS max_red_streak_length,
        any(reverted_commit_sha) AS reverted_commit_sha,
        any(reverted_pr_numbers) AS reverted_pr_numbers,
        any(merge_pr_numbers) AS merge_pr_numbers,
        max(is_autorevert) AS is_autorevert,
        any(autorevert_time) AS autorevert_time,
        any(autorevert_signal_keys) AS autorevert_signal_keys
    FROM reverts_only
    GROUP BY recovery_sha
)

-- Final output with recovery type classification
SELECT
    *,
    if(is_autorevert, 'autorevert_recovery', 'human_revert_recovery')
        AS recovery_type
FROM aggregated_reverts
ORDER BY recovery_time DESC
