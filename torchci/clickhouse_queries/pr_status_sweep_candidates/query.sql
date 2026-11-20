-- Include missing status comments as well as stale ones after label removal.
-- Read current mirror rows before applying mutable label/state/body filters.
-- created_at is a canonical GitHub ISO string; the rollout date is YYYY-MM-DD.
-- A null rollout date disables label-based candidates, retaining stale cleanup.
-- The small PR CTE is reused to restrict comment reads by their issue_url sort
-- key. PRs already included by labels need no comment lookup.
WITH open_prs AS (
    SELECT
        number,
        issue_url,
        COALESCE(
            created_at >= {prStatusStartDate: Nullable(String)}
            AND hasAny(labels.name, {workflowLabels: Array(String)}),
            false
        ) AS in_workflow
    FROM default.pull_request FINAL
    WHERE
        startsWith(dynamoKey, concat({repo: String}, '/'))
        AND state = 'open'
)

SELECT number
FROM open_prs
WHERE
    in_workflow
    OR issue_url IN
    (
        SELECT issue_url
        FROM default.issue_comment FINAL
        WHERE
            issue_url IN (
                SELECT issue_url FROM open_prs
                WHERE NOT in_workflow
            )
            AND user.login = {drciCommentAuthor: String}
            AND position(body, {drciCommentStart: String}) > 0
            AND position(body, {prStatusStart: String}) > 0
    )
ORDER BY number
