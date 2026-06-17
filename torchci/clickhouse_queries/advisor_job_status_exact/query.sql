-- Job events for specific SHAs, matched by exact "workflow / job" name.
-- Used for the advisor's PR head commit, where the full job name is known.
SELECT
    job.head_sha AS sha,
    job.conclusion_kg AS conclusion,
    CONCAT(job.workflow_name, ' / ', job.name) AS fullName,
    job.html_url AS htmlUrl,
    job.log_url AS logUrl,
    job.started_at AS startedAt,
    job.completed_at AS completedAt,
    job.torchci_classification_kg.'captures' AS failureCaptures,
    IF(
        job.torchci_classification_kg.'line' = '',
        [],
        [job.torchci_classification_kg.'line']
    ) AS failureLines
FROM default.workflow_job AS job FINAL
WHERE
    job.id IN (
        SELECT id
        FROM materialized_views.workflow_job_by_head_sha
        WHERE head_sha IN {shas: Array(String)}
    )
    AND job.head_sha IN {shas: Array(String)}
    AND job.repository_full_name = {repo: String}
    AND CONCAT(job.workflow_name, ' / ', job.name) = {jobName: String}
ORDER BY job.started_at DESC
