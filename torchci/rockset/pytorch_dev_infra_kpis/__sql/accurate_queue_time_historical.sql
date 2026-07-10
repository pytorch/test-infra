SELECT
    AVG(item.queue_time) as AVG_WAIT_TIME,
    MAX(item.queue_time) as MAX_WAIT_TIME,
    SUM(item.queue_time) as SUM_WAIT_TIME,
    COUNT(*) as NUM_RUNS,
    item.machine_type,
    item.granularity_bucket
FROM
    (
        SELECT
            -- Since we're grouping by run_url ARBITRARY(item.machine_type) should realistically only have 1 value
            PERCENT_RANK() OVER (
                PARTITION BY ARBITRARY(item.machine_type)
                ORDER BY
                    SUM(item.queue_time) DESC
            ) AS percentile,
            -- Summing here allows us to group queued events and non-queued events by their run_url so if a workflow
            -- was queued it'll sum with its 0 counterpart here
            SUM(item.queue_time) AS queue_time,
            ARBITRARY(item.machine_type) AS machine_type,
            item.granularity_bucket AS granularity_bucket
        FROM
            (
                SELECT
                    job.run_url,
                    IF(
                        LENGTH(job.labels) > 1,
                        ELEMENT_AT(job.labels, 2),
                        ELEMENT_AT(job.labels, 1)
                    ) as machine_type,
                    DATE_DIFF(
                        'second',
                        PARSE_DATETIME_ISO8601(workflow.created_at),
                        PARSE_DATETIME_ISO8601(job.started_at)
                    ) as queue_time,
                    FORMAT_ISO8601(
                        DATE_TRUNC(
                            :granularity,
                            job._event_time AT TIME ZONE :timezone
                        )
                    ) AS granularity_bucket,
                FROM
                    commons.workflow_job job
                    JOIN commons.workflow_run workflow on workflow.url = job.run_url
                WHERE
                    job.status = 'queued'
                    AND workflow.status = 'completed'
                    AND LENGTH(job.labels) > 0
                    AND job._event_time >= PARSE_DATETIME_ISO8601(:startTime)
                    AND job._event_time <= PARSE_DATETIME_ISO8601(:stopTime)
                UNION
                SELECT
                    job.run_url,
                    IF(
                        LENGTH(job.labels) > 1,
                        ELEMENT_AT(job.labels, 2),
                        ELEMENT_AT(job.labels, 1)
                    ) as machine_type,
                    0 AS queue_time,
                    FORMAT_ISO8601(
                        DATE_TRUNC(
                            :granularity,
                            job._event_time AT TIME ZONE :timezone
                        )
                    ) AS granularity_bucket,
                FROM
                    commons.workflow_job job
                    JOIN commons.workflow_run workflow on workflow.url = job.run_url
                WHERE
                    job.status = 'completed'
                    AND workflow.status = 'completed'
                    AND LENGTH(job.labels) > 0
                    AND job._event_time >= PARSE_DATETIME_ISO8601(:startTime)
                    AND job._event_time <= PARSE_DATETIME_ISO8601(:stopTime)
            ) item
        GROUP BY
            item.run_url,
            item.granularity_bucket
    ) item
WHERE
    (
        SELECT
            NOT IS_NAN(item.percentile)
            AND item.percentile >= (1.0 - :percentile)
    )
GROUP BY
    item.machine_type,
    item.granularity_bucket
ORDER BY
    MAX(item.queue_time) DESC
