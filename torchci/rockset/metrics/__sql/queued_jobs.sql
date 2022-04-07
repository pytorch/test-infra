SELECT
    DATE_DIFF('second', job._event_time, CURRENT_TIMESTAMP()) as queue_s,
    CONCAT(workflow.name, ' / ', job.name) as name,
    job.html_url,
    job.labels,
FROM
    commons.workflow_job job
    JOIN commons.workflow_run workflow HINT(access_path=column_scan) on workflow.id = job.run_id
WHERE
	workflow.repository.full_name = 'pytorch/pytorch'
    AND job.status = 'queued'
    AND job._event_time > (CURRENT_TIMESTAMP() - INTERVAL 1 DAY)
    AND job._event_time < (CURRENT_TIMESTAMP() - INTERVAL 10 MINUTE)
ORDER BY
    queue_s ASC
