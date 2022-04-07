with any_red as (
    SELECT
        time,
        sha,
        CAST(
            SUM(
                CASE
                    when conclusion = 'failure' THEN 1
                    when conclusion = 'timed_out' THEN 1
                    when conclusion = 'cancelled' THEN 1
                    ELSE 0
                END
            ) > 0 as int
        ) as any_red,
        COUNT(*)
    FROM
        (
            SELECT
                push._event_time as time,
                job.conclusion as conclusion,
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
                case
                    WHEN job.job.status = 'failed' then 'failure'
                    WHEN job.job.status = 'canceled' then 'cancelled'
                    else job.job.status
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
        count(*) > 10 -- Filter out jobs that didn't run anything.
        AND SUM(IF(conclusion is NULL, 1, 0)) = 0 -- Filter out commits that still have pending jobs.
    ORDER BY
        time DESC
)
SELECT
    AVG(any_red) as red,
from
    any_red
