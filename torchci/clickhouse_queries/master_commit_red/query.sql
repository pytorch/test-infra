--- This query is used to show the histogram of trunk red commits on HUD metrics page
--- during a period of time, separating real failures from flaky ones.
--- Jobs are grouped by base_name (stripping shard numbers) to handle flaky tests
--- that move between shards.
-- Split up the query into multiple CTEs to make it faster.
WITH commits AS (
    SELECT
        push.head_commit.'timestamp' AS time,
        push.head_commit.'id' AS sha
    FROM
    -- Not using final since push table doesn't really get updated
        push
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
        workflow_run.name AS name,
        commit.time AS time
    FROM
        workflow_run FINAL
    JOIN commits commit ON workflow_run.head_commit.'id' = commit.sha
    WHERE
        -- Limit it to workflows which block viable/strict upgrades
        workflow_run.name IN (
            'Lint',
            'pull',
            'trunk',
            'linux-aarch64'
        )
        AND workflow_run.event != 'workflow_run' -- Filter out workflow_run-triggered jobs, which have nothing to do with the SHA
        AND workflow_run.id IN (
            SELECT id FROM materialized_views.workflow_run_by_head_sha
            WHERE head_sha IN (SELECT sha FROM commits)
        )
),

all_jobs AS (
    SELECT
        all_runs.time AS time,
        all_runs.sha AS sha,
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
    FROM
        default.workflow_job job FINAL
    JOIN all_runs all_runs ON all_runs.id = workflow_job.run_id
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

-- Step 1: For each (sha, base_name, run_attempt), determine if this attempt
-- has any failures or is all green across all shards
attempt_status AS (
    SELECT
        time,
        sha,
        base_name,
        run_attempt,
        -- Does this attempt have ANY shard with failure?
        MAX(raw_conclusion IN ('failure', 'timed_out', 'cancelled'))
            AS attempt_has_failure,
        -- Does this attempt have any pending jobs?
        MAX(raw_conclusion = '') AS attempt_has_pending
    FROM all_jobs
    GROUP BY time, sha, base_name, run_attempt
),

-- Step 2: For each (sha, base_name), aggregate across all run_attempts
-- to determine: red (all attempts failed), flaky (some failed, some green), green (all green)
job_group_status AS (
    SELECT
        time,
        sha,
        base_name,
        -- Any attempt still pending?
        MAX(attempt_has_pending) AS has_pending,
        -- Did ALL attempts have at least one failure? (MIN=1 means all had failure)
        MIN(attempt_has_failure) AS all_attempts_failed,
        -- Did ANY attempt have a failure?
        MAX(attempt_has_failure) AS any_attempt_failed
    FROM attempt_status
    GROUP BY time, sha, base_name
),

commit_overall_conclusion AS (
    SELECT
        time,
        sha,
        CASE
            -- Any job group pending = pending
            WHEN SUM(has_pending) > 0 THEN 'pending'
            -- Any job group where ALL attempts failed = red (never recovered)
            WHEN SUM(all_attempts_failed) > 0 THEN 'red'
            -- Any job group where SOME attempts failed but not all = flaky (recovered)
            WHEN SUM(any_attempt_failed) > 0 THEN 'flaky'
            -- Everything passed on all attempts
            ELSE 'green'
        END AS overall_conclusion
    FROM
        job_group_status
    GROUP BY
        time,
        sha
    HAVING
        COUNT(*) > 10 -- Filter out jobs that didn't run anything.
    ORDER BY
        time DESC
)

SELECT
    toDate(
        date_trunc('hour', time),
        {timezone: String}
    ) AS granularity_bucket,
    countIf(overall_conclusion = 'red') AS red,
    countIf(overall_conclusion = 'flaky') AS flaky,
    countIf(overall_conclusion = 'pending') AS pending,
    countIf(overall_conclusion = 'green') AS green,
    COUNT(*) AS total
FROM
    commit_overall_conclusion
GROUP BY
    granularity_bucket
ORDER BY
    granularity_bucket ASC
