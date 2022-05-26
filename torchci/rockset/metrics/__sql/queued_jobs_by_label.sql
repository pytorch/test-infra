WITH queued_jobs as (
    SELECT
        DATE_DIFF('second', job._event_time, CURRENT_TIMESTAMP()) as queue_s,
        CONCAT(workflow.name, ' / ', job.name) as name,
        job.html_url,
        IF(
            LENGTH(job.labels) > 1,
            ELEMENT_AT(job.labels, 2),
            ELEMENT_AT(job.labels, 1)
        ) as machine_type,
    FROM
        commons.workflow_job job
        JOIN commons.workflow_run workflow on workflow.id = job.run_id
    WHERE
        workflow.repository.full_name = 'pytorch/pytorch'
        AND job.status = 'queued'
        AND job._event_time < (CURRENT_TIMESTAMP() - INTERVAL 5 MINUTE)
        /* These two conditions are workarounds for GitHub's broken API. Sometimes */
        /* jobs get stuck in a permanently "queued" state but definitely ran. We can */
        /* detect this by looking at whether any steps executed (if there were, */
        /* obviously the job started running), and whether the workflow was marked as */
        /* complete (somehow more reliable than the job-level API) */
        AND LENGTH(job.steps) = 0
        AND workflow.status != 'completed'
    ORDER BY
        queue_s DESC
)
SELECT
    COUNT(*) as count,
    MAX(queue_s) as avg_queue_s,
    machine_type,
FROM
    queued_jobs
GROUP BY
    machine_type
ORDER BY
    count DESC
