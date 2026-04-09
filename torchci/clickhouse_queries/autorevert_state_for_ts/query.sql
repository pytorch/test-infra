-- Fetch the most recent autorevert state snapshot per workflow set
-- at or before the target timestamp.
-- argMax picks the row with the highest ts per workflow set.
SELECT
    max(ts) AS snapshot_ts,
    argMax(state, ts) AS state,
    workflows,
    argMax(lookback_hours, ts) AS lookback_hours
FROM misc.autorevert_state
WHERE
    repo = {repo: String}
    AND ts <= toDateTime({target_ts: String})
    AND ts > toDateTime({target_ts: String}) - INTERVAL 24 HOUR
GROUP BY workflows
