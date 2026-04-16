SELECT
    COUNT(*) AS COUNT,
    job.name AS name
FROM
    workflow_job job
JOIN workflow_run workflow ON workflow.id = job.run_id
WHERE
    job.head_branch = 'main'
    AND workflow.name LIKE '%Binaries Validations%'
    AND workflow.event = 'schedule'
    AND job.name LIKE concat('%', {channel: String}, '%')
    AND job.conclusion IN ('failure', 'timed_out', 'cancelled')
    AND job.completed_at >= today() - 1
GROUP BY job.name
ORDER BY COUNT DESC;
