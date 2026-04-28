SELECT
    latest.duration_seconds AS duration_seconds,
    avg_recent.avg_duration_seconds AS avg_duration_seconds
FROM
    (
        SELECT
            DATE_DIFF('second', job.started_at, job.completed_at) AS duration_seconds
        FROM
            default.workflow_job job
        WHERE
            job.name IN {jobNames: Array(String)}
            AND job.conclusion = 'success'
            AND job.html_url LIKE '%/pytorch/pytorch/%'
            AND job.started_at > now() - INTERVAL 60 DAY
        ORDER BY
            job.completed_at DESC
        LIMIT 1
    ) AS latest
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
    ) AS avg_recent
