-- Lists the commits that viable/strict was advanced to (one row per promotion).
-- Powers the /viablestrict list page; each row links to the per-commit test
-- breakdown at /viablestrict/[sha].
--
-- NOTE: the push table has no push-event timestamp -- head_commit.timestamp is
-- the commit author time (this is also what strict_lag_sec orders by). The
-- "Update viable/strict" cron runs every ~30 min but only creates a push row
-- here when it actually advances the branch, so this list is exactly the set of
-- real promotions.
SELECT DISTINCT
    push.head_commit.id AS sha,
    push.head_commit.message AS message,
    push.head_commit.author.name AS author,
    push.head_commit.timestamp AS timestamp
FROM
    default.push
WHERE
    push.ref = 'refs/heads/viable/strict'
    AND push.repository.full_name = {repo: String}
    AND push.head_commit.id != ''
    AND push.head_commit.timestamp > now() - INTERVAL {days: Int64} DAY
ORDER BY
    timestamp DESC
