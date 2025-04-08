--- This query is used to show the histogram of trunk red commits on HUD metrics page
--- during a period of time
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
        (
            -- Limit it to workflows which block viable/strict upgrades
            workflow_run.name IN ('Lint', 'pull', 'trunk')
            OR workflow_run.name LIKE 'linux-binary%'
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
        CASE
            WHEN job.conclusion = 'failure' THEN 'red'
            WHEN job.conclusion = 'timed_out' THEN 'red'
            WHEN job.conclusion = 'cancelled' THEN 'red'
            WHEN job.conclusion = '' THEN 'pending'
            ELSE 'green'
        END AS conclusion,
        all_runs.sha AS sha
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

commit_overall_conclusion AS (
    SELECT
        time,
        sha,
        CASE
            WHEN countIf(conclusion = 'red') > 0 THEN 'red'
            WHEN countIf(conclusion = 'pending') > 0 THEN 'pending'
            ELSE 'green'
        END AS overall_conclusion
    FROM
        all_jobs
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
    countIf(overall_conclusion = 'pending') AS pending,
    countIf(overall_conclusion = 'green') AS green,
    COUNT(*) AS total
FROM
    commit_overall_conclusion
GROUP BY
    granularity_bucket
ORDER BY
    granularity_bucket ASC
