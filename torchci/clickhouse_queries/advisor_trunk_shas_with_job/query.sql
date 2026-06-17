-- Recent trunk SHAs (on the default branch) that have a finished run matching a
-- "workflow / job" LIKE pattern. Gives the advisor recent trunk baselines for
-- the failing job.
SELECT DISTINCT job.head_sha AS head_sha
FROM default.workflow_job AS job FINAL
WHERE
    job.id IN (
        SELECT id
        FROM materialized_views.workflow_job_by_created_at
        WHERE created_at > now() - INTERVAL 3 DAY
    )
    AND job.repository_full_name = {repo: String}
    AND job.head_branch = {branch: String}
    AND CONCAT(job.workflow_name, ' / ', job.name) LIKE {jobPattern: String}
    AND job.conclusion_kg IN ('success', 'failure', 'cancelled', 'timed_out')
ORDER BY job.started_at DESC
LIMIT {limit: UInt32}
