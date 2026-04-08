--- This query is used by HUD metrics page to get the list of queued jobs grouped by their labels
---
--- For EC2/LF runners: queue time = time in 'queued' status (created_at to now)
--- For ARC runners (labels containing l-): queue time = time in 'queued' status + container
---   initialization time (before actual work starts). Phase 2 captures jobs that
---   are in_progress but still initializing containers (<=2 steps completed).
---   Jobs with a recorded conclusion are excluded to avoid counting stale entries.
WITH possible_queued_jobs as (
    select id, run_id from default.workflow_job where
    created_at < (CURRENT_TIMESTAMP() - INTERVAL 5 MINUTE)
    AND created_at > (CURRENT_TIMESTAMP() - INTERVAL 1 WEEK)
    AND (
        --- EC2/LF: jobs still in queued status
        status = 'queued'
        OR
        --- ARC: jobs in_progress but possibly still initializing containers
        (status = 'in_progress'
         AND conclusion = ''
         AND arrayExists(x -> x LIKE '%l-%', labels))
    )
),
--- EC2/LF runners: existing logic, only jobs in queued status
ec2_queued_jobs AS (
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
        AND LENGTH(job.steps) = 0
        AND workflow.status != 'completed'
        --- Exclude ARC runners from this path
        AND NOT arrayExists(x -> x LIKE '%l-%', job.labels)
),
--- ARC runners: queued OR in_progress but still initializing containers
arc_queued_jobs AS (
    SELECT
        DATE_DIFF('second', job.created_at, CURRENT_TIMESTAMP()) AS queue_s,
        CONCAT(workflow.name, ' / ', job.name) AS name,
        job.html_url,
        IF(LENGTH(job.labels) > 1, job.labels [ 2 ], job.labels [ 1 ]) AS machine_type
    FROM
        default.workflow_job job final
        JOIN default.workflow_run workflow final ON workflow.id = job.run_id
    WHERE
        job.id in (select id from possible_queued_jobs)
        and workflow.id in (select run_id from possible_queued_jobs)
        and workflow.repository. 'full_name' = 'pytorch/pytorch'
        --- ARC runner detection: labels contain l- pattern
        AND arrayExists(x -> x LIKE '%l-%', job.labels)
        AND workflow.status != 'completed'
        AND job.conclusion = ''
        AND (
            --- Phase 1: still in queued status
            (job.status = 'queued' AND LENGTH(job.steps) = 0)
            OR
            --- Phase 2: picked up by runner but still initializing containers.
            --- Container init is always the first 2 steps (Set up job +
            --- Initialize containers). If only those steps exist, actual
            --- work hasn't started yet.
            (job.status = 'in_progress'
             AND LENGTH(job.steps) > 0
             AND LENGTH(job.steps) <= 2)
        )
)
SELECT
    COUNT(*) AS count,
    MAX(queue_s) AS avg_queue_s,
    machine_type,
    CURRENT_TIMESTAMP() AS time
FROM (
    SELECT queue_s, machine_type FROM ec2_queued_jobs
    UNION ALL
    SELECT queue_s, machine_type FROM arc_queued_jobs
)
GROUP BY
    machine_type
ORDER BY
    count DESC
SETTINGS allow_experimental_analyzer = 1;
