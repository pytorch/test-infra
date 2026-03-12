--- This query is used to show the histogram of trunk red commits on HUD metrics page
--- during a period of time, separating real failures from flaky ones.
--- Classification uses the LATEST attempt of each job (matching viable/strict logic):
---   red = some job's latest attempt is still failing (broken trunk)
---   flaky = all latest attempts passed, but some earlier attempt had a failure
---   green = no failures on any attempt
---   pending = some jobs haven't completed yet
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

-- Fetch job names marked as unstable via open GitHub issues (e.g. "UNSTABLE pull / linux-jammy / test (default)")
unstable_issue_names AS (
    SELECT
        replaceRegexpOne(issue.title, '^UNSTABLE\\s+', '') AS unstable_name
    FROM
        default.issues AS issue FINAL
    WHERE
        arrayExists(x -> x.'name' = 'unstable', issue.labels)
        AND issue.state = 'open'
        AND issue.title LIKE 'UNSTABLE%'
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
        has({workflowNames:Array(String)}, lower(workflow_run.name))
        AND workflow_run.event != 'workflow_run' -- Filter out workflow_run-triggered jobs, which have nothing to do with the SHA
        AND workflow_run.event != 'repository_dispatch' -- Filter out repository_dispatch-triggered jobs
        AND NOT (workflow_run.event = 'workflow_dispatch' AND workflow_run.head_branch LIKE 'trunk/%') -- Filter out restart jobs
        AND workflow_run.id IN (
            SELECT id FROM materialized_views.workflow_run_by_head_sha
            WHERE head_sha IN (SELECT sha FROM commits)
        )
),

all_jobs AS (
    SELECT
        all_runs.time AS time,
        all_runs.sha AS sha,
        job.conclusion_kg AS conclusion,
        -- rn = 1 is the latest attempt for each job (matching viable/strict logic)
        ROW_NUMBER() OVER (
            PARTITION BY all_runs.sha, job.name
            ORDER BY job.run_attempt DESC
        ) AS rn
    FROM
        default.workflow_job job FINAL
    JOIN all_runs all_runs ON all_runs.id = workflow_job.run_id
    WHERE
        job.name != 'ciflow_should_run'
        AND job.name != 'generate-test-matrix'
        AND job.name NOT LIKE '%rerun_disabled_tests%'
        AND job.name NOT LIKE '%mem_leak_check%'
        AND job.name NOT LIKE '%unstable%'
        -- Exclude jobs marked unstable via open GitHub issues
        AND CONCAT(all_runs.name, ' / ', job.name) NOT IN (SELECT unstable_name FROM unstable_issue_names)
        AND CONCAT(all_runs.name, ' / ', replaceRegexpOne(job.name, ' \\(([^,]*),.*\\)$', ' (\\1)')) NOT IN (SELECT unstable_name FROM unstable_issue_names)
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
            -- Any job still pending on its latest attempt
            WHEN countIf(rn = 1 AND conclusion = '') > 0 THEN 'pending'
            -- Any job whose latest attempt is still failing (broken trunk)
            WHEN countIf(rn = 1 AND conclusion IN ('failure', 'time_out', 'cancelled')) > 0 THEN 'red'
            -- All latest attempts passed, but some earlier attempt had a failure (flaky)
            WHEN countIf(conclusion IN ('failure', 'time_out', 'cancelled')) > 0 THEN 'flaky'
            -- No failures on any attempt
            ELSE 'green'
        END AS overall_conclusion
    FROM
        all_jobs
    GROUP BY
        time,
        sha
    HAVING
        countIf(rn = 1) > 10 -- Filter out commits that didn't run enough jobs
    ORDER BY
        time DESC
)

SELECT
    toDate(
        date_trunc({granularity: String}, time),
        {timezone: String}
    ) AS granularity_bucket,
    if(
        {usePercentage: Bool},
        countIf(overall_conclusion = 'red') * 100.0 / COUNT(*),
        toFloat64(countIf(overall_conclusion = 'red'))
    ) AS red,
    if(
        {usePercentage: Bool},
        countIf(overall_conclusion = 'flaky') * 100.0 / COUNT(*),
        toFloat64(countIf(overall_conclusion = 'flaky'))
    ) AS flaky,
    if(
        {usePercentage: Bool},
        countIf(overall_conclusion = 'pending') * 100.0 / COUNT(*),
        toFloat64(countIf(overall_conclusion = 'pending'))
    ) AS pending,
    if(
        {usePercentage: Bool},
        countIf(overall_conclusion = 'green') * 100.0 / COUNT(*),
        toFloat64(countIf(overall_conclusion = 'green'))
    ) AS green,
    COUNT(*) AS total
FROM
    commit_overall_conclusion
GROUP BY
    granularity_bucket
ORDER BY
    granularity_bucket ASC
