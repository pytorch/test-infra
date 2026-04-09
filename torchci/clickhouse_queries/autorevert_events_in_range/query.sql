-- Fetch non-dry-run autorevert events in a time range, filtered by workflows.
-- Used to show event activity counts between commits in the autorevert grid.
SELECT
    ts,
    action,
    commit_sha,
    workflows,
    source_signal_keys
FROM misc.autorevert_events_v2
WHERE
    repo = {repo: String}
    AND dry_run = 0
    AND ts >= toDateTime({startTime: String})
    AND ts <= toDateTime({endTime: String})
    AND hasAny(workflows, {filterWorkflows: Array(String)})
ORDER BY ts DESC
