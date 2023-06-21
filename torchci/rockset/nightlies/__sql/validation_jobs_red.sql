with commit_overall_conclusion as (
    SELECT
        time,
        CASE
            WHEN COUNT_IF(conclusion = 'red') > 0 THEN 'red'
            WHEN COUNT_IF(conclusion = 'pending') > 0 THEN 'pending'
            ELSE 'green'
        END as overall_conclusion
    FROM
        (
            SELECT
                job._event_time as time,
                CASE
                    WHEN job.conclusion = 'failure' THEN 'red'
                    WHEN job.conclusion = 'timed_out' THEN 'red'
                    WHEN job.conclusion = 'cancelled' THEN 'red'
                    WHEN job.conclusion IS NULL THEN 'pending'
                    ELSE 'green'
                END as conclusion
            FROM
                commons.workflow_job job
                JOIN commons.workflow_run workflow on workflow.id = job.run_id
            WHERE
                job.head_branch = 'main' 
                AND workflow.name = 'cron' 
                AND workflow.event = 'schedule' 
                AND job.name like CONCAT('%',:channel,'%') 
                AND workflow.repository.full_name = 'pytorch/builder' 
                AND job._event_time >= PARSE_DATETIME_ISO8601(:startTime)
                AND job._event_time < PARSE_DATETIME_ISO8601(:stopTime)
        ) as all_job
    GROUP BY
        time
    ORDER BY
        time DESC
)
SELECT
    FORMAT_TIMESTAMP(
        '%Y-%m-%d',
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



