SELECT
    all_commits.commit as commit
FROM
    push,
    UNNEST(push.commits as commit) as all_commits
WHERE
    all_commits.commit.id = :sha
ORDER BY
    all_commits.commit.timestamp DESC
LIMIT
    1
