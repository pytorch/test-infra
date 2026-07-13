SELECT
    DATE_TRUNC({granularity: String}, job.completed_at) AS granularity_bucket,
    job.name AS job_name,
    avg(DATE_DIFF('second', job.started_at, job.completed_at)) AS avg_duration_seconds,
    max(DATE_DIFF('second', job.started_at, job.completed_at)) AS max_duration_seconds,
    min(DATE_DIFF('second', job.started_at, job.completed_at)) AS min_duration_seconds,
    count(*) AS num_builds
FROM
    default.workflow_job job
WHERE
    job.name IN {jobNames: Array(String)}
    AND job.conclusion = 'success'
    AND job.head_branch = 'main'
    AND job.html_url LIKE '%/pytorch/pytorch/%'
    AND job.completed_at >= {startTime: DateTime64(3)}
    AND job.completed_at < {stopTime: DateTime64(3)}
GROUP BY
    granularity_bucket,
    job_name
ORDER BY
    granularity_bucket ASC,
    job_name ASC
