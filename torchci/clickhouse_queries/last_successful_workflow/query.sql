WITH workflow AS (
    SELECT
        head_commit.id AS head_commit_id,
        created_at
    FROM default.workflow_run
    WHERE
        conclusion = 'success'
        AND created_at > CURRENT_TIMESTAMP() - INTERVAL 15 DAY
        AND name = {workflowName: String}
    ORDER BY created_at DESC
),

push AS (
    SELECT push.head_commit.id AS head_commit_id
    FROM default.push
    WHERE
        ref IN ('refs/heads/master', 'refs/heads/main')
        AND repository.owner.name = 'pytorch'
        AND repository.name = 'pytorch'
)

SELECT
    DATE_DIFF('second', workflow.created_at, CURRENT_TIMESTAMP())
        AS last_success_seconds_ago
FROM workflow JOIN push
    ON workflow.head_commit_id = push.head_commit_id
ORDER BY
    workflow.created_at DESC
LIMIT 1
