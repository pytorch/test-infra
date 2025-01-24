select
    DATE_DIFF(
        'second',
        workflow.created_at,
        CURRENT_TIMESTAMP()
    ) as last_success_seconds_ago
from
    default.workflow_run workflow final
join default.push final on workflow.head_commit.'id' = push.head_commit.'id'
where
    push.ref in ('refs/heads/master', 'refs/heads/main')
    and push.repository.'owner'.'name' = 'pytorch'
    and push.repository.'name' = 'pytorch'
    and workflow.conclusion = 'success'
    and workflow.name = {workflowName: String}
order by
    workflow.created_at desc
limit
    1
