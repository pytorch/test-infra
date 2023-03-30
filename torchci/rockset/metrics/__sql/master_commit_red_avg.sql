WITH all_jobs AS (
    SELECT
        job.conclusion AS conclusion,
        push.head_commit.id AS sha,
        ROW_NUMBER() OVER(PARTITION BY job.name, push.head_commit.id ORDER BY job.run_attempt DESC) AS row_num,
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
        AND job.name NOT LIKE '%mem_leak_check%'
        AND workflow.event != 'workflow_run' -- Filter out worflow_run-triggered jobs, which have nothing to do with the SHA
        AND push.ref IN ('refs/heads/master', 'refs/heads/main')
        AND push.repository.owner.name = 'pytorch'
        AND push.repository.name = 'pytorch'
        AND push._event_time >= PARSE_DATETIME_ISO8601(:startTime)
        AND push._event_time < PARSE_DATETIME_ISO8601(:stopTime)
    UNION ALL
    SELECT
        CASE
            WHEN job.job.status = 'failed' then 'failure'
            WHEN job.job.status = 'canceled' then 'cancelled'
            ELSE job.job.status
        END AS conclusion,
        push.head_commit.id AS sha,
        ROW_NUMBER() OVER(PARTITION BY job.name, push.head_commit.id ORDER BY job.run_attempt DESC) AS row_num,
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
                    WHEN conclusion = 'failure' AND row_num = 1 THEN 1
                    WHEN conclusion = 'timed_out' AND row_num = 1 THEN 1
                    WHEN conclusion = 'cancelled' AND row_num = 1 THEN 1
                    ELSE 0
                END
            ) > 0 AS int
        ) AS broken_trunk_red,
    FROM
        all_jobs
    GROUP BY
        sha
    HAVING
        COUNT(sha) > 10 -- Filter out jobs that didn't run anything.
        AND SUM(IF(conclusion IS NULL, 1, 0)) = 0 -- Filter out commits that still have pending jobs.
)
SELECT
    AVG(broken_trunk_red) AS broken_trunk_red,
    AVG(any_red) - AVG(broken_trunk_red) AS flaky_red,
FROM
    all_reds