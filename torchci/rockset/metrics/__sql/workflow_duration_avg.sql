SELECT
    AVG(
        DATE_DIFF(
            'second',
            PARSE_TIMESTAMP_ISO8601(workflow.created_at),
            PARSE_TIMESTAMP_ISO8601(workflow.updated_at)
        )
    ) as duration_sec,
    name
FROM
    commons.workflow_run workflow
WHERE
    conclusion = 'success'
    AND name = :name
    AND workflow._event_time >= PARSE_DATETIME_ISO8601(:startTime)
    AND workflow._event_time < PARSE_DATETIME_ISO8601(:stopTime)
GROUP BY
    workflow.name
ORDER BY
    duration_sec DESC
