SELECT
    job.name as name,
    workflow.head_sha,
    CASE
        WHEN job.conclusion = 'failure' THEN 0
        WHEN job.conclusion = 'timed_out' THEN 0
        WHEN job.conclusion = 'cancelled' THEN 0
        WHEN job.conclusion IS NULL THEN NULL
        ELSE 1
    END as is_green,
FROM
    workflow_run workflow
    INNER JOIN commons.workflow_job job on workflow.id = job.run_id
WHERE
    job._event_time > CURRENT_TIMESTAMP() - INTERVAL 7 DAY
    AND workflow.name = 'pull'
GROUP BY
    job.name,
    workflow.head_sha,
    job.conclusion
