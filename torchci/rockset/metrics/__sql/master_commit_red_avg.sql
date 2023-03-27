WITH all_jobs AS (
    SELECT
        push._event_time AS time,
        job.conclusion AS conclusion,
        push.head_commit.id AS sha,
        ROW_NUMBER() OVER(PARTITION BY job.name, push.head_commit.id ORDER BY job.run_attempt DESC) AS attempt,
    FROM
        commons.workflow_job job
        JOIN commons.workflow_run workflow ON workflow.id = job.run_id
        JOIN push ON workflow.head_commit.id = push.head_commit.id
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
    UNION ALL
    SELECT
        push._event_time AS time,
        CASE
            WHEN job.job.status = 'failed' then 'failure'
            WHEN job.job.status = 'canceled' then 'cancelled'
            ELSE job.job.status
        END AS conclusion,
        push.head_commit.id AS sha,
        ROW_NUMBER() OVER(PARTITION BY job.name, push.head_commit.id ORDER BY job.run_attempt DESC) AS attempt
    FROM
        circleci.job job
        JOIN push ON job.pipeline.vcs.revision = push.head_commit.id
    WHERE
        push.ref IN ('refs/heads/master', 'refs/heads/main')
        AND push.repository.owner.name = 'pytorch'
        AND push.repository.name = 'pytorch'
        AND push._event_time >= PARSE_DATETIME_ISO8601(:startTime)
        AND push._event_time < PARSE_DATETIME_ISO8601(:stopTime)
),
all_reds AS (
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
    FROM
        all_jobs
    GROUP BY
        time,
        sha
    HAVING
        COUNT(sha) > 10 -- Filter out jobs that didn't run anything.
        AND SUM(IF(conclusion IS NULL, 1, 0)) = 0 -- Filter out commits that still have pending jobs.
),
broken_trunk_reds AS (
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
    FROM
        all_jobs
    WHERE
        -- If a job still fail after a retry, it will be counted as a broken trunk failure
        all_jobs.attempt = 1
    GROUP BY
        time,
        sha
    HAVING
        COUNT(sha) > 10 -- Filter out jobs that didn't run anything.
        AND SUM(IF(conclusion IS NULL, 1, 0)) = 0 -- Filter out commits that still have pending jobs.
)
SELECT
    AVG(broken_trunk_reds.any_red) AS broken_trunk_red,
    AVG(all_reds.any_red) - AVG(broken_trunk_reds.any_red) AS flaky_red,
FROM
    all_reds, broken_trunk_reds
