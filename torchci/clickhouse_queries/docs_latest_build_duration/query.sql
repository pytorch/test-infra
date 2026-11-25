SELECT
    recent.avg_duration_seconds AS duration_seconds,
    prior.avg_duration_seconds AS avg_duration_seconds
FROM
    (
        SELECT
            avg(DATE_DIFF('second', job.started_at, job.completed_at)) AS avg_duration_seconds
        FROM
            default.workflow_job job
        WHERE
            job.name IN {jobNames: Array(String)}
            AND job.conclusion = 'success'
            AND job.html_url LIKE '%/pytorch/pytorch/%'
            AND job.started_at > now() - INTERVAL 7 DAY
    ) AS recent
CROSS JOIN
    (
        SELECT
            avg(DATE_DIFF('second', job.started_at, job.completed_at)) AS avg_duration_seconds
        FROM
            default.workflow_job job
        WHERE
            job.name IN {jobNames: Array(String)}
            AND job.conclusion = 'success'
            AND job.html_url LIKE '%/pytorch/pytorch/%'
            AND job.started_at > now() - INTERVAL 14 DAY
            AND job.started_at <= now() - INTERVAL 7 DAY
    ) AS prior
