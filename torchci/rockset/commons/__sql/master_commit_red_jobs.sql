WITH all_jobs AS (
    SELECT
        push._event_time AS time,
        job.conclusion AS conclusion,
        push.head_commit.id AS sha,
        push.head_commit.author.username AS author,
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
        (
            CASE
                WHEN push.head_commit.author.username = 'pytorchmergebot' THEN push.head_commit.message
                ELSE NULL
            END
        ) AS body,
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
        AND push.ref = 'refs/heads/master'
        AND push.repository.owner.name = 'pytorch'
        AND push.repository.name = 'pytorch'
        AND push._event_time >= PARSE_DATETIME_ISO8601(:startTime)
        AND push._event_time < PARSE_DATETIME_ISO8601(:stopTime)
),
reds AS (
    SELECT
        time,
        sha,
        ARRAY_REMOVE(
            ARRAY_AGG(
                IF (conclusion = 'failure' OR conclusion = 'timed_out' OR conclusion = 'cancelled', IF (name LIKE '%(%' AND name NOT LIKE '%)%', CONCAT(name, ')'), name))
            ),
            NULL
        ) AS names,
        COUNT_IF(conclusion = 'failure' OR conclusion = 'timed_out' OR conclusion = 'cancelled') AS red_count,
        author,
        body
    FROM
        all_jobs
    GROUP BY
        time,
        sha,
        author,
        body
    HAVING
        COUNT(*) > 10 -- Filter out jobs that didn't run anything.
        AND SUM(IF(conclusion IS NULL, 1, 0)) = 0 -- Filter out commits that still have pending jobs.
)
SELECT
    FORMAT_TIMESTAMP('%Y-%m-%d', DATE_TRUNC(:granularity, time)) AS granularity_bucket,
    time,
    sha,
    red_count,
    author,
    body,
    names
FROM
    reds
ORDER BY
    time DESC
