SELECT
    DATE_TRUNC({granularity: String}, job.completed_at) AS granularity_bucket,
    job.name AS job_name,
    count(*) AS total_builds,
    countIf(job.conclusion = 'success') AS successful_builds,
    round(countIf(job.conclusion = 'success') / count(*) * 100, 1) AS success_rate
FROM
    default.workflow_job job
WHERE
    job.name IN {jobNames: Array(String)}
    AND job.conclusion IN ('success', 'failure')
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
