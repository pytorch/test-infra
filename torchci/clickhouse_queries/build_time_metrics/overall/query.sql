SELECT
    date_trunc({granularity: String}, j.started_at) AS bucket,
    round(avg(date_diff('second', j.started_at, j.completed_at)), 2)
        AS duration_sec,
    j.name AS job_name
FROM default.workflow_job j
WHERE
    j.started_at >= {startTime: DateTime64(3) }
    AND j.started_at < {stopTime: DateTime64(3) }
    AND j.conclusion = 'success'
    AND j.html_url LIKE '%pytorch/pytorch%'
    AND j.workflow_name IN ('pull', 'trunk', 'periodic', 'inductor', 'slow')
    AND j.name LIKE '% / build'
GROUP BY bucket, job_name
HAVING count(*) > 10
ORDER BY bucket, job_name
