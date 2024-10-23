SELECT
    AVG(
        DATE_DIFF(
            'second',
            workflow.created_at,
            workflow.updated_at
        )
    ) as duration_sec,
    name
FROM
    default.workflow_run workflow final
WHERE
    conclusion = 'success'
    AND lower(workflow.name) in {workflowNames: Array(String)}
    AND workflow.created_at >= {startTime: DateTime64(3)}
    AND workflow.created_at < {stopTime: DateTime64(3)}
    AND workflow.run_attempt = 1
GROUP BY
    workflow.name
ORDER BY
    duration_sec DESC
