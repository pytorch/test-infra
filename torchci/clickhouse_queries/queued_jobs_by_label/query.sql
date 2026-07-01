--- This query is used by HUD metrics page to get the list of queued jobs grouped by their labels
---
--- For EC2/LF runners: queue time = time in 'queued' status (created_at to now)
--- For ARC runners (labels containing l-): queue time = time in 'queued' status + container
---   initialization time (before actual work starts). Phase 2 captures jobs that
---   are in_progress but still initializing containers (<=2 steps completed).
---   Jobs with a recorded conclusion are excluded to avoid counting stale entries.
---
--- Optimization notes (mirrors PR #8088 on queued_jobs_aggregate):
---   * `FINAL` on workflow_job is replaced with a manual ReplacingMergeTree
---     dedup via `LIMIT 1 BY id ORDER BY _inserted_at DESC`, scoped to the
---     candidate id set. Cheaper than global FINAL because we only read parts
---     containing candidate ids.
---   * `workflow_run` keeps FINAL but is aggressively pre-filtered (status,
---     repository, run_id in candidates) before the JOIN so the right side
---     shrinks to a handful of rows.
---   * The `workflow.status != 'completed'` filter (and the repo filter)
---     are pushed into a single `latest_workflows` CTE used by both the
---     EC2 and ARC paths instead of being repeated in two FINAL JOINs.
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
--- Manual ReplacingMergeTree dedup using _inserted_at MATERIALIZED column,
--- scoped to the candidate id set. Replaces `FINAL` on workflow_job.
latest_jobs AS (
    SELECT
        id,
        run_id,
        status,
        conclusion,
        created_at,
        labels,
        steps,
        name,
        html_url,
        runner_group_name
    FROM default.workflow_job
    WHERE id IN (SELECT id FROM possible_queued_jobs)
    ORDER BY id, _inserted_at DESC
    LIMIT 1 BY id
),
--- Pre-filter workflow_run to non-completed pytorch/pytorch runs before the
--- JOIN so the right side is tiny. FINAL stays here but is cheap because the
--- predicate keeps the read set small.
latest_workflows AS (
    SELECT
        id,
        name
    FROM default.workflow_run FINAL
    WHERE
        id IN (SELECT run_id FROM possible_queued_jobs)
        AND status != 'completed'
        AND repository.'full_name' = 'pytorch/pytorch'
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
        latest_jobs job
        JOIN latest_workflows workflow ON workflow.id = job.run_id
    WHERE
        job.status = 'queued'
        AND LENGTH(job.steps) = 0
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
        latest_jobs job
        JOIN latest_workflows workflow ON workflow.id = job.run_id
    WHERE
        --- ARC runner detection: labels contain l- pattern
        arrayExists(x -> x LIKE '%l-%', job.labels)
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
