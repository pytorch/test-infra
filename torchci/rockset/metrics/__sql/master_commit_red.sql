with commit_overall_conclusion as (
    SELECT
        time,
        sha,
        CASE
            WHEN COUNT_IF(conclusion = 'red') > 0 THEN 'red'
            WHEN COUNT_IF(conclusion = 'pending') > 0 THEN 'pending'
            ELSE 'green'
        END as overall_conclusion
    FROM
        (
            SELECT
                push._event_time as time,
                CASE
                    WHEN job.conclusion = 'failure' THEN 'red'
                    WHEN job.conclusion = 'timed_out' THEN 'red'
                    WHEN job.conclusion = 'cancelled' THEN 'red'
                    WHEN job.conclusion IS NULL THEN 'pending'
                    ELSE 'green'
                END as conclusion,
                push.head_commit.id as sha,
            FROM
                commons.workflow_job job
                JOIN commons.workflow_run workflow on workflow.id = job.run_id
                JOIN push on workflow.head_commit.id = push.head_commit.id
            WHERE
                job.name != 'ciflow_should_run'
                AND job.name != 'generate-test-matrix'
                AND workflow.event != 'workflow_run' -- Filter out worflow_run-triggered jobs, which have nothing to do with the SHA
                AND push.ref = 'refs/heads/master'
                AND push.repository.owner.name = 'pytorch'
                AND push.repository.name = 'pytorch'
                AND push._event_time >= PARSE_DATETIME_ISO8601(:startTime)
                AND push._event_time < PARSE_DATETIME_ISO8601(:stopTime)
            UNION ALL
            SELECT
                push._event_time as time,
                CASE
                    WHEN job.job.status = 'failed' THEN 'red'
                    WHEN job.job.status = 'timed_out' THEN 'red'
                    WHEN job.job.status = 'canceled' THEN 'red'
                    WHEN job.job.status IS NULL THEN 'pending'
                    ELSE 'green'
                END as conclusion,
                push.head_commit.id as sha,
            FROM
                circleci.job job
                JOIN push on job.pipeline.vcs.revision = push.head_commit.id
            WHERE
                push.ref = 'refs/heads/master'
                AND push.repository.owner.name = 'pytorch'
                AND push.repository.name = 'pytorch'
                AND push._event_time >= PARSE_DATETIME_ISO8601(:startTime)
                AND push._event_time < PARSE_DATETIME_ISO8601(:stopTime)
        ) as all_job
    GROUP BY
        time,
        sha
    HAVING
        COUNT(*) > 10 -- Filter out jobs that didn't run anything.
    ORDER BY
        time DESC
)
SELECT
    FORMAT_TIMESTAMP(
        '%m-%d-%y',
        DATE_TRUNC('hour', time),
        :timezone
    ) AS granularity_bucket,
    COUNT_IF(overall_conclusion = 'red') AS red,
    COUNT_IF(overall_conclusion = 'pending') AS pending,
    COUNT_IF(overall_conclusion = 'green') AS green,
    COUNT(*) as total,
FROM
    commit_overall_conclusion
GROUP BY
    granularity_bucket
ORDER BY
    granularity_bucket ASC
