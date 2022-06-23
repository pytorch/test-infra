SELECT
    PARSE_DATETIME_ISO8601(workflow.created_at) AT TIME ZONE :timezone as created_at_time,
    SUM(DATE_DIFF(
        'second',
        PARSE_TIMESTAMP_ISO8601(job.started_at),
        PARSE_TIMESTAMP_ISO8601(job.completed_at)
    )) as duration_avg_sec,
    CONCAT(workflow.name, ' / ', SUBSTR(job.name, 1, STRPOS(job.name, ', ') - 1)) as full_name,
    workflow.head_sha
FROM
    commons.workflow_job job
    JOIN commons.workflow_run workflow on workflow.id = job.run_id
WHERE
    job._event_time >= PARSE_DATETIME_ISO8601(:startTime)
    AND job._event_time < PARSE_DATETIME_ISO8601(:stopTime)
    AND workflow.name IN ('pull')
	AND workflow.head_branch LIKE 'master'
    AND job.name LIKE '%test%,%'
GROUP BY
    created_at_time,
    full_name,
    workflow.head_sha
