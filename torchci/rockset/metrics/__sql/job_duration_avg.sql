SELECT
    AVG(
        DATE_DIFF(
            'second',
            PARSE_TIMESTAMP_ISO8601(job.started_at),
            PARSE_TIMESTAMP_ISO8601(job.completed_at)
        )
    ) as duration_sec,
    COUNT(*) as count,
    CONCAT(workflow.name, ' / ', job.name) as name
FROM
    commons.workflow_job job
    JOIN commons.workflow_run workflow on workflow.id = job.run_id
WHERE
    job.name != 'ciflow_should_run'
    AND job.name != 'generate-test-matrix'
    AND workflow.repository.full_name = 'pytorch/pytorch'
    AND job._event_time >= PARSE_DATETIME_ISO8601(:startTime)
    AND job._event_time < PARSE_DATETIME_ISO8601(:stopTime)
    AND job.conclusion = 'success'
    AND workflow.head_branch LIKE :branch
GROUP BY
    name
ORDER BY
    COUNT(*) * AVG(
        DATE_DIFF(
            'second',
            PARSE_TIMESTAMP_ISO8601(job.started_at),
            PARSE_TIMESTAMP_ISO8601(job.completed_at)
        )
    ) DESC
