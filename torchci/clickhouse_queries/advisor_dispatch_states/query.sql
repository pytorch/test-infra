-- Latest AI advisor dispatch state + retry_count per signal_key for one PR head
-- commit. Used to dedup auto-dispatch. argMax over the replacing version returns
-- the latest row; reading (state, retry_count) as one tuple keeps them paired
-- even if two writes ever share a version timestamp.
SELECT
    signal_key,
    argMax((state, retry_count), version) AS sr
FROM misc.ai_advisor_dispatches
WHERE
    owner = {owner: String}
    AND repo = {repo: String}
    AND head_sha = {headSha: String}
    AND signal_key IN {signalKeys: Array(String)}
GROUP BY signal_key
