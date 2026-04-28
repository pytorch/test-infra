SELECT
    DATE_DIFF('second', job.started_at, job.completed_at) AS duration_seconds
FROM
    default.workflow_job job
WHERE
    job.name IN {jobNames: Array(String)}
    AND job.conclusion = 'success'
    AND job.head_branch = 'main'
    AND job.html_url LIKE '%/pytorch/pytorch/%'
    AND job.started_at > now() - INTERVAL 60 DAY
ORDER BY
    job.completed_at DESC
LIMIT
    1
