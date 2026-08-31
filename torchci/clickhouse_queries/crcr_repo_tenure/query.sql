-- level_since = earliest started_at at the repo's current level; floors at ~100 days due to crcr_workflow_job's TTL.
-- current_level uses argMax to deterministically pick the level as of the most recent started_at.
-- first_seen/last_seen span all levels, for the "2 weeks of recent data" L3 promotion prerequisite.
WITH (
    SELECT argMax(downstream_repo_level, started_at)
    FROM default.crcr_workflow_job FINAL
    WHERE downstream_repo = {repo: String}
) AS current_level
SELECT
    current_level,
    minIf(started_at, downstream_repo_level = current_level) AS level_since,
    min(started_at) AS first_seen,
    max(started_at) AS last_seen
FROM
    default.crcr_workflow_job FINAL
WHERE
    downstream_repo = {repo: String}
