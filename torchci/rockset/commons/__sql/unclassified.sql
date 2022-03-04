SELECT
	job.html_url,
    CONCAT(
        'https://ossci-raw-job-status.s3.amazonaws.com/log/',
        CAST(job.id as string)
    ) as log_url,
    job.id as id,
FROM
    "GitHub-Actions".workflow_job job
    JOIN "GitHub-Actions".workflow_run workflow on job.run_id = workflow.id
    LEFT JOIN "GitHub-Actions".classification on classification.job_id = job.id
WHERE
    job.conclusion = 'failure'
    AND classification.line IS NULL
    AND job._event_time > (CURRENT_TIMESTAMP() - HOURS(24))
ORDER BY
	job._event_time ASC