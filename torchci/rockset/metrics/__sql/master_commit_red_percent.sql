WITH all_jobs AS (
    SELECT
        push._event_time as time,
        job.conclusion AS conclusion,
        push.head_commit.id AS sha,
        ROW_NUMBER() OVER(PARTITION BY job.name, push.head_commit.id ORDER BY job.run_attempt DESC) AS attempt,
    FROM
        push
        JOIN commons.workflow_run workflow ON workflow.head_commit.id = push.head_commit.id
        JOIN commons.workflow_job job ON workflow.id = job.run_id
    WHERE
        job.name != 'ciflow_should_run'
        AND job.name != 'generate-test-matrix'
        AND ( -- Limit it to workflows which block viable/strict upgrades
            ARRAY_CONTAINS(SPLIT(:workflowNames, ','), LOWER(workflow.name))
            OR workflow.name like 'linux-binary%'
            OR workflow.name like 'windows-binary%'
        )
        AND job.name NOT LIKE '%rerun_disabled_tests%'
        AND workflow.event != 'workflow_run' -- Filter out worflow_run-triggered jobs, which have nothing to do with the SHA
        AND push.ref IN ('refs/heads/master', 'refs/heads/main')
        AND push.repository.owner.name = 'pytorch'
        AND push.repository.name = 'pytorch'
        AND push._event_time >= PARSE_DATETIME_ISO8601(:startTime)
        AND push._event_time < PARSE_DATETIME_ISO8601(:stopTime)
),
any_red AS (
    SELECT
        time,
        sha,
        CAST(
            SUM(
                CASE
                    WHEN conclusion = 'failure' THEN 1
                    WHEN conclusion = 'timed_out' THEN 1
                    WHEN conclusion = 'cancelled' THEN 1
                    ELSE 0
                END
            ) > 0 AS int
        ) AS any_red,
        CAST(
            SUM(
                CASE
                    WHEN conclusion = 'failure' AND attempt = 1 THEN 1
                    WHEN conclusion = 'timed_out' AND attempt = 1 THEN 1
                    WHEN conclusion = 'cancelled' AND attempt = 1 THEN 1
                    ELSE 0
                END
            ) > 0 AS int
        ) AS broken_trunk_red,
    FROM
        all_jobs
    GROUP BY
        time,
        sha
    HAVING
        count(sha) > 10 -- Filter out jobs that didn't run anything.
        AND SUM(IF(conclusion is NULL, 1, 0)) = 0 -- Filter out commits that still have pending jobs.
),
classified_red AS (
    SELECT
        FORMAT_TIMESTAMP('%Y-%m-%d', DATE_TRUNC(:granularity, time)) AS granularity_bucket,
        ARRAY_CREATE(
            ARRAY_CREATE('Broken trunk', AVG(broken_trunk_red)),
            ARRAY_CREATE('Flaky', AVG(any_red) - AVG(broken_trunk_red)),
            ARRAY_CREATE('Total', AVG(any_red))
        ) AS metrics,
    FROM
        any_red
    GROUP BY
        granularity_bucket
)
SELECT
    classified_red.granularity_bucket,
    ELEMENT_AT(metrics.metric, 1) AS name,
    ELEMENT_AT(metrics.metric, 2) AS metric,
FROM
    classified_red
    CROSS JOIN UNNEST(classified_red.metrics AS metric) AS metrics
