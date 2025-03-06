--- This query is used by HUD metrics page to get the list of queued jobs
WITH possible_queued_jobs AS (
    SELECT
        id,
        run_id
    FROM default.workflow_job -- FINAL not needed since we just use this to filter a table that has already been FINALed
    WHERE
        status = 'queued'
        AND created_at < (CURRENT_TIMESTAMP() - INTERVAL 5 MINUTE)
        AND created_at > (CURRENT_TIMESTAMP() - INTERVAL 1 WEEK)
)

SELECT
    DATE_DIFF(
        'second',
        job.created_at,
        CURRENT_TIMESTAMP()
    ) AS queue_s,
    CONCAT(workflow.name, ' / ', job.name) AS name,
    job.html_url,
    IF(
        LENGTH(job.labels) = 0,
        'N/A',
        IF(
            LENGTH(job.labels) > 1,
            job.labels[2],
            job.labels[1]
        )
    ) AS machine_type
FROM
    default.workflow_job job FINAL
JOIN default.workflow_run workflow FINAL ON workflow.id = job.run_id
WHERE
    job.id IN (SELECT id FROM possible_queued_jobs)
    AND workflow.id IN (SELECT run_id FROM possible_queued_jobs)
    AND workflow.repository.'full_name' = 'pytorch/pytorch'
    AND job.status = 'queued'
    /* These two conditions are workarounds for GitHub's broken API. Sometimes */
    /* jobs get stuck in a permanently "queued" state but definitely ran. We can */
    /* detect this by looking at whether any steps executed (if there were, */
    /* obviously the job started running), and whether the workflow was marked as */
    /* complete (somehow more reliable than the job-level API) */
    AND LENGTH(job.steps) = 0
    AND workflow.status != 'completed'
ORDER BY
    queue_s DESC
SETTINGS allow_experimental_analyzer = 1;
