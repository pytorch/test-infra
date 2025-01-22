--- This query is used to show the histogram of trunk red commits on HUD metrics page
--- during a period of time
WITH all_jobs AS (
    SELECT
        push.head_commit.'timestamp' AS time,
        CASE
            WHEN job.conclusion = 'failure' THEN 'red'
            WHEN job.conclusion = 'timed_out' THEN 'red'
            WHEN job.conclusion = 'cancelled' THEN 'red'
            WHEN job.conclusion = '' THEN 'pending'
            ELSE 'green'
        END AS conclusion,
        push.head_commit.'id' AS sha
    FROM
        workflow_job job FINAL
    JOIN workflow_run FINAL ON workflow_run.id = workflow_job.run_id
    JOIN push FINAL ON workflow_run.head_commit.'id' = push.head_commit.'id'
    WHERE
        job.name != 'ciflow_should_run'
        AND job.name != 'generate-test-matrix'
        AND (
            -- Limit it to workflows which block viable/strict upgrades
            workflow_run.name IN ('Lint', 'pull', 'trunk')
            OR workflow_run.name LIKE 'linux-binary%'
        )
        AND job.name NOT LIKE '%rerun_disabled_tests%'
        AND job.name NOT LIKE '%unstable%'
        AND workflow_run.event != 'workflow_run' -- Filter out workflow_run-triggered jobs, which have nothing to do with the SHA
        AND push.ref IN (
            'refs/heads/master', 'refs/heads/main'
        )
        AND push.repository.'owner'.'name' = 'pytorch'
        AND push.repository.'name' = 'pytorch'
        AND push.head_commit.'timestamp' >= {startTime: DateTime64(3)}
        AND push.head_commit.'timestamp' < {stopTime: DateTime64(3)}
),

commit_overall_conclusion AS (
    SELECT
        time,
        sha,
        CASE
            WHEN COUNTIF(conclusion = 'red') > 0 THEN 'red'
            WHEN COUNTIF(conclusion = 'pending') > 0 THEN 'pending'
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
    TODATE(
        DATE_TRUNC('hour', time),
        {timezone: String}
    ) AS granularity_bucket,
    COUNTIF(overall_conclusion = 'red') AS red,
    COUNTIF(overall_conclusion = 'pending') AS pending,
    COUNTIF(overall_conclusion = 'green') AS green,
    COUNT(*) AS total
FROM
    commit_overall_conclusion
GROUP BY
    granularity_bucket
ORDER BY
    granularity_bucket ASC
