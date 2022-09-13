SELECT
	job.html_url,
    CONCAT(
        'https://ossci-raw-job-status.s3.amazonaws.com/log/',
        CAST(job.id as string)
    ) as log_url,
    job.id as id,
FROM
    commons.workflow_job job
    JOIN commons.workflow_run workflow on job.run_id = workflow.id
WHERE
	job.conclusion = 'failure'
    AND job._event_time > (CURRENT_TIMESTAMP() - HOURS(24))
    AND job.torchci_classification IS NULL
ORDER BY
	job._event_time ASC
LIMIT :n
