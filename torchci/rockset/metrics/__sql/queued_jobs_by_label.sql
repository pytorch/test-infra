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
        JOIN push on workflow.head_commit.id = push.head_commit.id
    WHERE
        push.repository.owner.name = 'pytorch'
        AND push.repository.name = 'pytorch'
        AND job.status = 'queued'
        AND job._event_time > (CURRENT_TIMESTAMP() - INTERVAL 1 DAY)
        AND job._event_time < (CURRENT_TIMESTAMP() - INTERVAL 10 MINUTE)
    ORDER BY
        job._event_time DESC
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
