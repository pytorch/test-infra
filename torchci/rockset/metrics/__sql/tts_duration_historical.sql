SELECT
    FORMAT_ISO8601(
        DATE_TRUNC(
            :granularity,
            job._event_time AT TIME ZONE :timezone
        )
    ) AS granularity_bucket,
    AVG(DATE_DIFF(
        'second',
        PARSE_TIMESTAMP_ISO8601(workflow.created_at) AT TIME ZONE :timezone,
        PARSE_TIMESTAMP_ISO8601(job.completed_at) AT TIME ZONE :timezone
    )) as tts_avg_sec,
    AVG(DATE_DIFF(
        'second',
        PARSE_TIMESTAMP_ISO8601(job.started_at) AT TIME ZONE :timezone,
        PARSE_TIMESTAMP_ISO8601(job.completed_at) AT TIME ZONE :timezone
    )) as duration_avg_sec,
    CONCAT(workflow.name, ' / ', job.name) as full_name,
FROM
    commons.workflow_job job
    JOIN commons.workflow_run workflow on workflow.id = job.run_id
WHERE
    job._event_time >= PARSE_DATETIME_ISO8601(:startTime)
    AND job._event_time < PARSE_DATETIME_ISO8601(:stopTime)
    AND workflow.name IN ('pull', 'trunk', 'nightly', 'periodic')
	AND workflow.head_branch LIKE 'master'
GROUP BY
    granularity_bucket,
    full_name
ORDER BY
    full_name ASC