SELECT
    commit_sha,
    workflows,
    source_signal_keys,
    ts
FROM misc.autorevert_events_v2
WHERE
    repo = {repo: String}
    AND commit_sha = {sha: String}
    AND action = 'revert'
    AND dry_run = 0
    AND failed = 0
ORDER BY ts DESC
