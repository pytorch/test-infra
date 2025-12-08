--- This query is used to show the histogram of trunk red commits on HUD metrics page
--- during a period of time, separating real failures from flaky ones
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
        job.name AS job_name,
        job.conclusion AS raw_conclusion,
        ROW_NUMBER() OVER (
            PARTITION BY job.name, all_runs.sha
            ORDER BY job.run_attempt DESC
        ) AS row_num
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

job_status AS (
    SELECT
        time,
        sha,
        job_name,
        -- Is there a pending job?
        MAX(CASE WHEN raw_conclusion = '' THEN 1 ELSE 0 END) AS has_pending,
        -- Job is flaky if it both failed AND succeeded
        MAX(raw_conclusion IN ('failure', 'timed_out', 'cancelled'))
        AND MAX(raw_conclusion IN ('success', 'neutral')) AS is_flaky,
        -- Job is truly red if it failed but never succeeded
        MAX(raw_conclusion IN ('failure', 'timed_out', 'cancelled'))
        AND NOT MAX(raw_conclusion IN ('success', 'neutral', '')) AS ever_failed
    FROM all_jobs
    GROUP BY time, sha, job_name
),

commit_overall_conclusion AS (
    SELECT
        time,
        sha,
        CASE
            -- Any job pending = pending
            WHEN SUM(has_pending) > 0 THEN 'pending'
            -- Any job that only failed (never succeeded) = red
            WHEN SUM(ever_failed) > 0 THEN 'red'
            -- Any job that was flaky (failed but also succeeded) = flaky
            WHEN SUM(is_flaky) > 0 THEN 'flaky'
            -- Everything passed
            ELSE 'green'
        END AS overall_conclusion
    FROM
        job_status
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
