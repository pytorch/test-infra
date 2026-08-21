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
        job.created_at AS created_at,
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
        job.created_at AS created_at,
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
            --- work hasn't started yet. The 10 min cap guards against stale
            --- step data in ClickHouse — the job is either running ok or fails
            --- already if it has less than 2 steps after 10 minutes
            (job.status = 'in_progress'
             AND LENGTH(job.steps) > 0
             AND LENGTH(job.steps) <= 2
             AND job.created_at > (CURRENT_TIMESTAMP() - INTERVAL 10 MINUTE))
        )
),
--- Last time a runner of each machine type actually picked up work.
--- Not filtered by repository: these runner pools are shared across the org,
--- so any repo's job starting proves the pool was serving that label.
last_started_by_label AS (
    SELECT
        IF(LENGTH(labels) > 1, labels [ 2 ], labels [ 1 ]) AS machine_type,
        MAX(started_at) AS last_started_at
    FROM default.workflow_job
    WHERE
        started_at > (CURRENT_TIMESTAMP() - INTERVAL 1 DAY)
        AND status != 'queued'
        AND LENGTH(labels) > 0
    GROUP BY machine_type
),
--- A queued row is stale when the pool for its label has already started a job
--- that was created later than this one. Dispatch within a label is roughly
--- FIFO, so being overtaken means this row was orphaned (typically a dropped
--- terminating webhook), not that capacity is unavailable. When a pool is
--- genuinely starved nothing newer starts, so real backlogs stay unflagged.
classified_jobs AS (
    SELECT
        q.queue_s AS queue_s,
        q.machine_type AS machine_type,
        l.last_started_at > q.created_at AS is_stale
    FROM (
        SELECT queue_s, created_at, machine_type FROM ec2_queued_jobs
        UNION ALL
        SELECT queue_s, created_at, machine_type FROM arc_queued_jobs
    ) AS q
    LEFT JOIN last_started_by_label AS l ON l.machine_type = q.machine_type
)
SELECT
    COUNT(*) AS count,
    --- Unchanged: max over all rows. Kept under the historical name so the
    --- persisted queue_times_historical column and its consumers still work.
    MAX(queue_s) AS avg_queue_s,
    --- Same statistic with stale rows removed: the queue signal to trust.
    MAX(IF(is_stale, 0, queue_s)) AS active_queue_s,
    countIf(is_stale) AS stale_count,
    machine_type,
    CURRENT_TIMESTAMP() AS time
FROM classified_jobs
GROUP BY
    machine_type
ORDER BY
    count DESC
SETTINGS allow_experimental_analyzer = 1;
