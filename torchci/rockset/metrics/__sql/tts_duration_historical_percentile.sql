SELECT
    granularity_bucket,
    MAX(tts_sec) AS tts_percentile_sec,
    MAX(duration_sec) AS duration_percentile_sec,
    full_name
FROM (
    SELECT
        granularity_bucket,
        tts_sec,
        PERCENT_RANK() OVER (PARTITION BY full_name ORDER BY tts_sec DESC) AS tts_percentile,
        duration_sec,
        PERCENT_RANK() OVER (PARTITION BY full_name ORDER BY duration_sec DESC) AS duration_percentile,
        full_name,
    FROM (
        SELECT
            FORMAT_ISO8601(
                DATE_TRUNC(
                    :granularity,
                    job._event_time AT TIME ZONE :timezone
                )
            ) AS granularity_bucket,
            DATE_DIFF(
                'second',
                PARSE_TIMESTAMP_ISO8601(workflow.created_at) AT TIME ZONE :timezone,
                PARSE_TIMESTAMP_ISO8601(job.completed_at) AT TIME ZONE :timezone
            ) AS tts_sec,
            DATE_DIFF(
                'second',
                PARSE_TIMESTAMP_ISO8601(job.started_at) AT TIME ZONE :timezone,
                PARSE_TIMESTAMP_ISO8601(job.completed_at) AT TIME ZONE :timezone
            ) AS duration_sec,
            CONCAT(workflow.name, ' / ', job.name) as full_name
        FROM
            commons.workflow_job job
            JOIN commons.workflow_run workflow on workflow.id = job.run_id
        WHERE
            job._event_time >= PARSE_DATETIME_ISO8601(:startTime)
            AND job._event_time < PARSE_DATETIME_ISO8601(:stopTime)
            AND workflow.name IN ('pull', 'trunk', 'nightly', 'periodic')
            AND workflow.head_branch LIKE :branch
    ) AS tts_duration
) AS p
WHERE
    (SELECT p.tts_percentile >= (1.0 - :percentile) OR p.duration_percentile >= (1.0 - :percentile))
GROUP BY
    granularity_bucket,
    full_name
ORDER BY
    full_name ASC
