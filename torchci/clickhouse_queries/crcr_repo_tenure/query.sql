-- level_since = earliest started_at at the repo's current level; floors at ~100 days due to crcr_workflow_job's TTL.
WITH (
    SELECT anyLast(downstream_repo_level)
    FROM default.crcr_workflow_job FINAL
    WHERE downstream_repo = {repo: String}
) AS current_level
SELECT
    current_level,
    minIf(started_at, downstream_repo_level = current_level) AS level_since
FROM
    default.crcr_workflow_job FINAL
WHERE
    downstream_repo = {repo: String}
