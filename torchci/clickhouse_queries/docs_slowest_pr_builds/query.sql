SELECT
    job.name AS job_name,
    job.head_sha AS sha,
    CONCAT('https://github.com/pytorch/pytorch/pull/',
        extractAllGroups(job.html_url, '\/pull\/(\d+)\/')[1][1]
    ) AS pr_url,
    extractAllGroups(job.html_url, '\/pull\/(\d+)\/')[1][1] AS pr_number,
    DATE_DIFF('second', job.started_at, job.completed_at) AS duration_seconds,
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
    duration_seconds DESC
LIMIT
    {limit: Int32}
