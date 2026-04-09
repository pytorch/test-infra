-- Fetch the most recent autorevert state snapshot per workflow set
-- that is at or before the target timestamp.
-- Uses a subquery to find the max ts per workflow set, then fetches
-- the full state rows.
SELECT
    s.ts,
    s.state,
    s.workflows,
    s.lookback_hours
FROM misc.autorevert_state s
INNER JOIN (
    SELECT
        workflows,
        max(ts) AS max_ts
    FROM misc.autorevert_state
    WHERE
        repo = {repo: String}
        AND ts <= {ts: DateTime}
    GROUP BY workflows
) latest ON s.workflows = latest.workflows AND s.ts = latest.max_ts
WHERE s.repo = {repo: String}
