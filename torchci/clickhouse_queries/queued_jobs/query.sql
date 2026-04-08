--- This query is used by HUD metrics page to get the list of queued jobs
---
--- For EC2/LF runners: only jobs in 'queued' status
--- For ARC runners (labels containing l-): jobs in 'queued' status + jobs in 'in_progress'
---   still initializing containers (<=2 steps completed). Jobs with a recorded
---   conclusion are excluded to avoid counting stale entries.
WITH possible_queued_jobs AS (
    SELECT
        id,
        run_id
    FROM default.workflow_job -- FINAL not needed since we just use this to filter a table that has already been FINALed
    WHERE
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
        ) AS machine_type,
        workflow.head_sha AS head_sha,
        workflow.head_branch AS head_branch,
        workflow.event AS event,
        CASE
            WHEN
                workflow.head_branch LIKE 'trunk/%'
                AND workflow.event = 'workflow_dispatch'
                THEN 'autorevert'
            WHEN workflow.head_branch LIKE 'ciflow/%' THEN 'ciflow'
            WHEN
                workflow.head_branch = 'main' OR workflow.event = 'push'
                THEN 'main'
            ELSE 'other'
        END AS source_type,
        CASE
            WHEN workflow.head_branch LIKE 'ciflow/trunk/%'
                THEN
                    replaceRegexpOne(workflow.head_branch, '^ciflow/trunk/', '')
            WHEN workflow.head_branch LIKE 'ciflow/%' THEN
                replaceRegexpOne(workflow.head_branch, '^ciflow/[^/]+/', '')
        END AS ciflow_id
    FROM
        default.workflow_job job FINAL
    JOIN default.workflow_run workflow FINAL ON workflow.id = job.run_id
    WHERE
        job.id IN (SELECT id FROM possible_queued_jobs)
        AND workflow.id IN (SELECT run_id FROM possible_queued_jobs)
        AND workflow.repository.'full_name' = 'pytorch/pytorch'
        AND job.status = 'queued'
        AND LENGTH(job.steps) = 0
        AND workflow.status != 'completed'
        --- Exclude ARC runners from this path
        AND NOT arrayExists(x -> x LIKE '%l-%', job.labels)
),
--- ARC runners: queued OR in_progress but still initializing containers
arc_queued_jobs AS (
    SELECT
        DATE_DIFF(
            'second',
            job.created_at,
            CURRENT_TIMESTAMP()
        ) AS queue_s,
        CONCAT(workflow.name, ' / ', job.name) AS name,
        job.html_url,
        IF(
            LENGTH(job.labels) > 1,
            job.labels[2],
            job.labels[1]
        ) AS machine_type,
        workflow.head_sha AS head_sha,
        workflow.head_branch AS head_branch,
        workflow.event AS event,
        CASE
            WHEN
                workflow.head_branch LIKE 'trunk/%'
                AND workflow.event = 'workflow_dispatch'
                THEN 'autorevert'
            WHEN workflow.head_branch LIKE 'ciflow/%' THEN 'ciflow'
            WHEN
                workflow.head_branch = 'main' OR workflow.event = 'push'
                THEN 'main'
            ELSE 'other'
        END AS source_type,
        CASE
            WHEN workflow.head_branch LIKE 'ciflow/trunk/%'
                THEN
                    replaceRegexpOne(workflow.head_branch, '^ciflow/trunk/', '')
            WHEN workflow.head_branch LIKE 'ciflow/%' THEN
                replaceRegexpOne(workflow.head_branch, '^ciflow/[^/]+/', '')
        END AS ciflow_id
    FROM
        default.workflow_job job FINAL
    JOIN default.workflow_run workflow FINAL ON workflow.id = job.run_id
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
            --- step data in ClickHouse — if a job has been around longer
            --- than that, the step count is likely outdated.
            (job.status = 'in_progress'
             AND LENGTH(job.steps) > 0
             AND LENGTH(job.steps) <= 2
             AND job.created_at > (CURRENT_TIMESTAMP() - INTERVAL 10 MINUTE))
        )
)
SELECT * FROM (
    SELECT * FROM ec2_queued_jobs
    UNION ALL
    SELECT * FROM arc_queued_jobs
)
ORDER BY
    queue_s DESC
SETTINGS allow_experimental_analyzer = 1;
