--- This query is used by HUD metrics page to get the list of queued jobs
SET final = 1;
SELECT
    job.status,
    DATE_DIFF('second', job.started_at, CURRENT_TIMESTAMP()) AS queue_s,
    CONCAT(workflow.name, ' / ', job.name) AS name,
    job.html_url,
    IF(
        LENGTH(job.labels) = 0,
        'N/A',
        IF(LENGTH(job.labels) > 1, job.labels [ 2 ], job.labels [ 1 ])
    ) AS machine_type
FROM
    workflow_job job
    JOIN workflow_run workflow ON workflow.id = job.run_id
WHERE
    workflow.repository.'full_name' = 'pytorch/pytorch'
    AND job.status = 'queued'
    AND job.started_at < (CURRENT_TIMESTAMP() - INTERVAL 5 MINUTE)
    /* These two conditions are workarounds for GitHub's broken API. Sometimes */
    /* jobs get stuck in a permanently "queued" state but definitely ran. We can */
    /* detect this by looking at whether any steps executed (if there were, */
    /* obviously the job started running), and whether the workflow was marked as */
    /* complete (somehow more reliable than the job-level API) */
    AND LENGTH(job.steps) = 0
    AND workflow.status != 'completed'
ORDER BY
    queue_s DESC
