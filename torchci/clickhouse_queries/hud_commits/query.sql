-- Commit list for the HUD landing-page grid, read from default.push instead of
-- the GitHub REST API.
--
-- arrayJoin over `commits` rather than head_commit: a ghstack land pushes the
-- whole stack in one event, so head_commit alone omits the non-tip commits.
-- head_commit is always the last element of `commits`, so array position DESC
-- orders the commits of a single push head/newest-first.
--
-- No FINAL, and the two-stage shape, are deliberate: FINAL forces a full merge
-- that defeats the read-in-order tail scan (~25x slower here) and push has no
-- duplicate rows in practice; the inner query keeps the wide scan on the cheap
-- sort-key columns so only the projected commit subcolumns are decompressed
-- (never the large added/modified/removed file lists).
SELECT
    sha,
    message,
    url,
    formatDateTime(ts, '%Y-%m-%dT%H:%i:%SZ', 'UTC') AS timestamp,
    author_username,
    author_name
FROM (
    SELECT
        commits.id AS ids,
        commits.message AS messages,
        commits.url AS urls,
        commits.timestamp AS tss,
        commits.author.username AS author_usernames,
        commits.author.name AS author_names,
        head_commit.timestamp AS push_ts
    FROM default.push
    PREWHERE
        repository.full_name = {repo: String}
        AND ref = concat('refs/heads/', {branch: String})
    ORDER BY head_commit.timestamp DESC
    LIMIT {per_page: Int32} + {offset: Int32}
)
ARRAY JOIN
    ids AS sha,
    messages AS message,
    urls AS url,
    tss AS ts,
    author_usernames AS author_username,
    author_names AS author_name,
    arrayEnumerate(ids) AS commit_pos
ORDER BY push_ts DESC, commit_pos DESC
LIMIT {per_page: Int32} OFFSET {offset: Int32}
