-- Return every immutable lifecycle event for the most recently updated audit
-- decisions. The UI groups these by decision_id so a proposal and its applied
-- or closed outcome remain one decision with a complete timeline.
WITH recent_decisions AS (
    SELECT
        decision_id,
        max(recorded_at) AS latest_recorded_at
    FROM default.crcr_level_audit
    WHERE downstream_repo = {repo: String}
    GROUP BY decision_id
    ORDER BY latest_recorded_at DESC, decision_id DESC
    LIMIT {limit: UInt32}
)

SELECT
    event_id,
    decision_id,
    downstream_repo,
    previous_level,
    new_level,
    decision_kind,
    decision_source,
    event_state,
    evaluation_window_start,
    evaluation_window_end,
    criteria_snapshot_json,
    reason,
    proposal_pr_url,
    approval_pr_url,
    configuration_commit_sha,
    configuration_commit_url,
    decision_actor,
    recorded_by,
    recorded_at,
    effective_at,
    criteria_schema_version
FROM default.crcr_level_audit
WHERE
    downstream_repo = {repo: String}
    AND decision_id IN (SELECT decision_id FROM recent_decisions)
ORDER BY recorded_at DESC, event_id DESC
LIMIT 1 BY event_id
