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
            CONCAT(' / ', ELEMENT_AT(SPLIT(ELEMENT_AT(SPLIT(job.name, ' / '), 2), ', '), 1))
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
        AND job.name LIKE '%/%'
        AND ARRAY_CONTAINS(SPLIT(:workflowNames, ','), LOWER(workflow.name))
        AND workflow.event != 'workflow_run' -- Filter out worflow_run-triggered jobs, which have nothing to do with the SHA
        AND push.ref = 'refs/heads/main'
        AND push.repository.owner.name = 'pytorch'
        AND push.repository.name = 'pytorch'
        AND push._event_time >= PARSE_DATETIME_ISO8601(:startTime)
        AND push._event_time < PARSE_DATETIME_ISO8601(:stopTime)
),
filtered_jobs AS (
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
        author,
        body
    FROM
        all_jobs
    GROUP BY
        time,
        sha,
        name,
        author,
        body
    HAVING
        COUNT(*) >= 1 -- Filter out jobs that didn't run anything.
        AND SUM(IF(conclusion IS NULL, 1, 0)) = 0 -- Filter out commits that still have pending jobs.
),
reds AS (
    SELECT
        time,
        sha,
        ARRAY_REMOVE(
            ARRAY_AGG(
                IF (any_red > 0, name)
            ),
            NULL
        ) AS failures,
        ARRAY_REMOVE(
            ARRAY_AGG(
                IF (any_red = 0, name)
            ),
            NULL
        ) AS successes,
        author,
        body
    FROM
        filtered_jobs
    GROUP BY
        time,
        sha,
        author,
        body
)
SELECT
    time,
    sha,
    author,
    body,
    failures,
    successes
FROM
    reds
ORDER BY
    time DESC
