-- Fetch the most recent autorevert state snapshot per workflow set
-- at or before the target timestamp.
-- argMax picks the row with the highest ts per workflow set.
SELECT
    max(ts) AS ts,
    argMax(state, ts) AS state,
    workflows,
    argMax(lookback_hours, ts) AS lookback_hours
FROM misc.autorevert_state
WHERE
    repo = {repo: String}
    AND ts <= {ts: DateTime}
    AND ts > toDateTime({ts: DateTime}) - INTERVAL 24 HOUR
GROUP BY workflows
