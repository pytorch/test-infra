--- This query is used by HUD metrics page to get the list of queued jobs grouped by their labels
WITH possible_queued_jobs as (
    select id, run_id from default.workflow_job where status = 'queued'
    AND created_at < (CURRENT_TIMESTAMP() - INTERVAL 5 MINUTE)
    AND created_at > (CURRENT_TIMESTAMP() - INTERVAL 1 WEEK)
), queued_jobs AS (
    SELECT
        DATE_DIFF('second', job.created_at, CURRENT_TIMESTAMP()) AS queue_s,
        CONCAT(workflow.name, ' / ', job.name) AS name,
        job.html_url,
        IF(
            LENGTH(job.labels) = 0,
            IF (
                job.runner_group_name IS NOT null
                AND job.runner_group_name != 'Default'
                AND job.runner_group_name != 'GitHub Actions'
                AND job.runner_group_name != ''
                AND job.runner_group_name != 'linux.rocm.gpu.group',
                job.runner_group_name,
                'N/A'
            ),
            IF(LENGTH(job.labels) > 1, job.labels [ 2 ], job.labels [ 1 ])
        ) AS machine_type
    FROM
        default.workflow_job job final
        JOIN default.workflow_run workflow final ON workflow.id = job.run_id
    WHERE
        job.id in (select id from possible_queued_jobs)
        and workflow.id in (select run_id from possible_queued_jobs)
        and workflow.repository. 'full_name' = 'pytorch/pytorch'
        AND job.status = 'queued'
        AND job.created_at < (CURRENT_TIMESTAMP() - INTERVAL 5 MINUTE)
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
    COUNT(*) AS count,
    MAX(queue_s) AS avg_queue_s,
    machine_type,
    CURRENT_TIMESTAMP() AS time
FROM
    queued_jobs
GROUP BY
    machine_type
ORDER BY
    count DESC
SETTINGS allow_experimental_analyzer = 1;
