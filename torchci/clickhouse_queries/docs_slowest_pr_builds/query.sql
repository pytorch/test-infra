SELECT
    job.name AS job_name,
    job.head_sha AS sha,
    w.pull_requests[1].'number' AS pr_number,
    CONCAT(
        'https://github.com/pytorch/pytorch/pull/',
        toString(w.pull_requests[1].'number')
    ) AS pr_url,
    round(DATE_DIFF('second', job.started_at, job.completed_at) / 60, 1) AS duration_minutes,
    job.completed_at AS completed_at
FROM
    default.workflow_job job
    JOIN default.workflow_run w FINAL ON w.id = job.run_id
WHERE
    job.name IN {jobNames: Array(String)}
    AND job.conclusion = 'success'
    AND job.html_url LIKE '%/pytorch/pytorch/%'
    AND job.completed_at >= {startTime: DateTime64(3)}
    AND job.completed_at < {stopTime: DateTime64(3)}
    AND LENGTH(w.pull_requests) >= 1
ORDER BY
    duration_minutes DESC
LIMIT
    {limit: Int32}
