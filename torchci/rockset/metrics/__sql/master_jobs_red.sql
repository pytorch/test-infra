SELECT
    CAST(DATE_TRUNC('hour', time) as string) AS hour,
    AVG(
        CASE
            when conclusion = 'failure' THEN 1
            when conclusion = 'timed_out' THEN 1
            when conclusion = 'cancelled' THEN 1
            ELSE 0
        END
    ) as red,
FROM
    (
        SELECT
            job._event_time as time,
            job.conclusion as conclusion,
        FROM
            commons.workflow_job job
            JOIN commons.workflow_run workflow on workflow.id = job.run_id
            JOIN push on workflow.head_commit.id = push.head_commit.id
        WHERE
            job.name != 'ciflow_should_run'
            AND job.name != 'generate-test-matrix'
            AND push.ref = 'refs/heads/master'
            AND push.repository.owner.name = 'pytorch'
            AND push.repository.name = 'pytorch'
            AND job._event_time >= PARSE_DATETIME_ISO8601(:startTime)
            AND job._event_time < PARSE_DATETIME_ISO8601(:stopTime)
        UNION ALL
        SELECT
            job._event_time as time,
            case
                WHEN job.job.status = 'failed' then 'failure'
                WHEN job.job.status = 'canceled' then 'cancelled'
                else job.job.status
            END as conclusion,
        FROM
            circleci.job job
            JOIN push on job.pipeline.vcs.revision = push.head_commit.id
        WHERE
            push.ref = 'refs/heads/master'
            AND push.repository.owner.name = 'pytorch'
            AND push.repository.name = 'pytorch'
            AND job._event_time >= PARSE_DATETIME_ISO8601(:startTime)
            AND job._event_time < PARSE_DATETIME_ISO8601(:stopTime)
    ) as all_job
GROUP BY
    DATE_TRUNC('hour', time)
ORDER BY
    DATE_TRUNC('hour', time) DESC
