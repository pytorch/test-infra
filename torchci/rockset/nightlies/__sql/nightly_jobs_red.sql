SELECT
    FORMAT_ISO8601(
        DATE_TRUNC(:granularity, time)
    ) AS granularity_bucket,
    AVG(
        CASE
            when conclusion = 'failure' THEN 1
            when conclusion = 'timed_out' THEN 1
            when conclusion = 'cancelled' THEN 1
             when conclusion = 'skipped' THEN 1
            ELSE 0
        END
    ) as red,
FROM
    (
        SELECT
            job._event_time AT TIME ZONE :timezone as time,
            job.conclusion as conclusion,
        FROM
            commons.workflow_job job
            JOIN commons.workflow_run workflow on workflow.id = job.run_id
            JOIN push on workflow.head_commit.id = push.head_commit.id
        WHERE
            job.name NOT LIKE '%generate-matrix%'
            AND job.name NOT LIKE '%unittests%'
            AND workflow.name NOT IN ('cron', 'Bandit', 'tests')
            AND push.ref = 'refs/heads/nightly'
            AND push.repository.owner.name = 'pytorch'
            AND push.repository.name = 'pytorch'
            AND job._event_time >= PARSE_DATETIME_ISO8601(:startTime)
            AND job._event_time < PARSE_DATETIME_ISO8601(:stopTime)
    ) as all_job
GROUP BY
    DATE_TRUNC(:granularity, time)
ORDER BY
    DATE_TRUNC(:granularity, time) ASC
