select
    DATE_DIFF(
        'second',
        workflow._event_time,
        CURRENT_TIMESTAMP()
    ) as last_success_seconds_ago
from
    workflow_run workflow
    JOIN push on workflow.head_commit.id = push.head_commit.id
where
    push.ref = 'refs/heads/master'
    AND push.repository.owner.name = 'pytorch'
    AND push.repository.name = 'pytorch'
    AND workflow.conclusion = 'success'
    AND workflow.name = :workflowName
order by
    workflow._event_time desc
LIMIT
    1
