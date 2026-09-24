SELECT
    job.name AS job_name,
    job.head_sha AS sha,
    job.html_url AS job_url,
    round(DATE_DIFF('second', job.started_at, job.completed_at) / 60, 1) AS duration_minutes,
    job.completed_at AS completed_at
FROM
    default.workflow_job job
WHERE
    job.name IN {jobNames: Array(String)}
    AND job.conclusion = 'success'
    AND job.html_url LIKE '%/pytorch/pytorch/%'
    AND job.completed_at >= {startTime: DateTime64(3)}
    AND job.completed_at < {stopTime: DateTime64(3)}
ORDER BY
    duration_minutes DESC
LIMIT
    {limit: Int32}
