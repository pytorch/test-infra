SELECT
    DATE_DIFF(
        'second',
        workflow.created_at,
        CURRENT_TIMESTAMP()
    ) AS last_success_seconds_ago
FROM
    default.workflow_run workflow FINAL
JOIN default.push FINAL ON workflow.head_commit.'id' = push.head_commit.'id'
WHERE
    push.ref IN ('refs/heads/master', 'refs/heads/main')
    AND push.repository.'owner'.'name' = 'pytorch'
    AND push.repository.'name' = 'pytorch'
    AND workflow.conclusion = 'success'
    AND workflow.name = {workflowName: String}
ORDER BY
    workflow.created_at DESC
LIMIT
    1
