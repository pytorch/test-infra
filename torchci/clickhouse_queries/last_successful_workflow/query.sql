select
    DATE_DIFF(
        'second',
        workflow.created_at,
        CURRENT_TIMESTAMP()
    ) as last_success_seconds_ago
from
    default.workflow_run workflow final
    JOIN default.push final on workflow.head_commit.'id' = push.head_commit.'id'
where
    push.ref IN ('refs/heads/master', 'refs/heads/main')
    AND push.repository.'owner'.'name' = 'pytorch'
    AND push.repository.'name' = 'pytorch'
    AND workflow.conclusion = 'success'
    AND workflow.name = {workflowName: String}
order by
    workflow.created_at DESC
LIMIT
    1
