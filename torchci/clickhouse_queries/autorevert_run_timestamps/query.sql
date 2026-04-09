-- List autorevert run timestamps (state snapshots) in a time range.
-- Used to render dots on the timeline showing when autorevert ran.
-- Lightweight: returns only ts and workflows, no state blob.
SELECT
    ts,
    workflows
FROM misc.autorevert_state
WHERE
    repo = {repo: String}
    AND ts >= toDateTime({startTime: String})
    AND ts <= toDateTime({endTime: String})
    AND hasAny(workflows, {filterWorkflows: Array(String)})
ORDER BY ts DESC
