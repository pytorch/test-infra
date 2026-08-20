-- Commit list for the HUD landing-page grid, read from default.push instead of
-- the GitHub REST API.
--
-- arrayJoin over `commits` rather than head_commit: a ghstack land pushes the
-- whole stack in one event, so head_commit alone omits the non-tip commits.
-- head_commit is always the last element of `commits`, so array position DESC
-- orders the commits of a single push head/newest-first.
--
-- The inner ORDER BY uses the tupleElement(head_commit, ...) sort-key expression
-- rather than head_commit.<field> dot syntax: only the exact sort-key expression
-- lets ClickHouse read in sort-key order and stop after LIMIT rows instead of
-- scanning the whole table. The head_commit.id term also makes the LIMIT cutoff
-- deterministic when pushes share a timestamp.
--
-- No FINAL: default.push can hold several rows for one head_commit.id (the same
-- push stored under different dynamoKey), but dynamoKey is part of the sort key,
-- so ReplacingMergeTree treats those rows as distinct and FINAL would not merge
-- them. `LIMIT 1 BY` dedups by head sha before the ARRAY JOIN (with the downstream
-- keyBy(sha) as backstop). The two-stage shape keeps the scan on the small
-- sort-key columns so only the projected commit subcolumns are decompressed,
-- never the large added/modified/removed file lists.
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
    ORDER BY tupleElement(head_commit, 'timestamp') DESC, tupleElement(head_commit, 'id') DESC
    LIMIT 1 BY tupleElement(head_commit, 'id')
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
