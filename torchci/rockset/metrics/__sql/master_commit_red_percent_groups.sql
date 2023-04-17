WITH all_jobs AS (
    SELECT
        push._event_time AS time,
        job.conclusion AS conclusion,
        push.head_commit.id AS sha,
        CONCAT(
            workflow.name,
            ' / ',
            ELEMENT_AT(SPLIT(job.name, ' / '), 1),
            IF(
                job.name LIKE '%/%',
                CONCAT(' / ', ELEMENT_AT(SPLIT(ELEMENT_AT(SPLIT(job.name, ' / '), 2), ', '), 1)),
                ''
            )
        ) AS name,
    FROM
        commons.workflow_job job
        JOIN commons.workflow_run workflow ON workflow.id = job.run_id
        JOIN push on workflow.head_commit.id = push.head_commit.id
    WHERE
        job.name != 'ciflow_should_run'
        AND job.name != 'generate-test-matrix'
        AND job.name NOT LIKE '%rerun_disabled_tests%'
        AND job.name NOT LIKE '%filter%'
        AND (
            LOWER(workflow.name) = 'lint'
            OR job.name LIKE '%/%'
        )
        AND ARRAY_CONTAINS(SPLIT(:workflowNames, ','), LOWER(workflow.name))
        AND workflow.event != 'workflow_run' -- Filter out worflow_run-triggered jobs, which have nothing to do with the SHA
        AND push.ref = 'refs/heads/main'
        AND push.repository.owner.name = 'pytorch'
        AND push.repository.name = 'pytorch'
        AND push._event_time >= PARSE_DATETIME_ISO8601(:startTime)
        AND push._event_time < PARSE_DATETIME_ISO8601(:stopTime)
),
reds AS(
    SELECT
        time,
        sha,
        IF (name LIKE '%(%' AND name NOT LIKE '%)%', CONCAT(name, ')'), name) AS name,
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
        COUNT(*) AS c
    FROM
        all_jobs
    GROUP BY
        time,
        sha,
        name
    HAVING
        COUNT(*) >= 1 -- Filter out jobs that didn't run anything.
        AND SUM(IF(conclusion IS NULL, 1, 0)) = 0 -- Filter out commits that still have pending jobs.
    ORDER BY
        time DESC
),
reds_percentage AS (
    SELECT
        FORMAT_TIMESTAMP('%Y-%m-%d', DATE_TRUNC(:granularity, time)) AS granularity_bucket,
        name,
        ROUND(AVG(any_red) * 100, 2) AS red,
    FROM
        reds
    GROUP BY
        granularity_bucket,
        name
)
SELECT
    *
FROM
    reds_percentage
WHERE
    red > 0
ORDER BY
    name ASC
