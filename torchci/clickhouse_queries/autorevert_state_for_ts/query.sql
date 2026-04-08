-- Fetch autorevert state snapshots near a target timestamp.
-- Returns rows from multiple workflow sets for merging.
-- Each workflow set stores a separate row every ~5 minutes.
SELECT
    ts,
    state,
    workflows,
    lookback_hours
FROM misc.autorevert_state
WHERE
    repo = {repo: String}
    AND ts <= {ts: DateTime}
    AND ts > toDateTime({ts: DateTime}) - INTERVAL 10 MINUTE
ORDER BY ts DESC
