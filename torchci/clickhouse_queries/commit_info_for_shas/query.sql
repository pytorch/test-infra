-- Fetch commit metadata (title, author, PR number) for a set of SHAs.
-- Uses the push table which contains commit messages from trunk pushes.
SELECT DISTINCT
    p.head_commit.id AS sha,
    p.head_commit.message AS message,
    p.head_commit.author.name AS author,
    p.head_commit.timestamp AS time
FROM default.push p
WHERE p.head_commit.id IN {shas: Array(String)}
  AND p.repository.full_name = {repo: String}
ORDER BY p.head_commit.timestamp DESC
