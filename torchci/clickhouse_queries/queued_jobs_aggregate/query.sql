--- This query is used by the AWS autoscalers to scale up runner types that
--- have had jobs waiting for them for a significant period of time.
---
--- This query returns the number of jobs per runner type that have been
--- queued for too long, which the autoscalers use to determine how many
--- additional runners to spin up.

WITH possible_queued_jobs AS (
    SELECT
        id,
        run_id
    FROM default.workflow_job
    WHERE
        status = 'queued'
        AND created_at < (
        -- Only consider jobs that have been queued for a significant period of time
            CURRENT_TIMESTAMP() - INTERVAL 30 MINUTE
        )
        AND created_at > (
        -- Queued jobs are automatically cancelled after this long. Any allegedly pending
        -- jobs older than this are actually bad data
            CURRENT_TIMESTAMP() - INTERVAL 3 DAY
        )
),

queued_jobs AS (
    SELECT
        DATE_DIFF(
            'minute',
            job.created_at,
            CURRENT_TIMESTAMP()
        ) AS queue_m,
        workflow.repository.owner.login AS org,
        workflow.repository.name AS repo,
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
        ) AS runner_label
    FROM
        default.workflow_job job FINAL
    JOIN default.workflow_run workflow FINAL ON workflow.id = job.run_id
    WHERE
        job.id IN (SELECT id FROM possible_queued_jobs)
        AND workflow.id IN (SELECT run_id FROM possible_queued_jobs)
        AND workflow.repository.owner.login IN ('pytorch', 'pytorch-labs')
        AND job.status = 'queued'
        /* These two conditions are workarounds for GitHub's broken API. Sometimes */
        /* jobs get stuck in a permanently "queued" state but definitely ran. We can */
        /* detect this by looking at whether any steps executed (if there were, */
        /* obviously the job started running), and whether the workflow was marked as */
        /* complete (somehow more reliable than the job-level API) */
        AND LENGTH(job.steps) = 0
        AND workflow.status != 'completed'
    ORDER BY
        queue_m DESC
)

SELECT
    runner_label,
    org,
    repo,
    count(*) AS num_queued_jobs,
    min(queue_m) AS min_queue_time_minutes,
    max(queue_m) AS max_queue_time_minutes
FROM queued_jobs
GROUP BY runner_label, org, repo
ORDER BY max_queue_time_minutes DESC
SETTINGS allow_experimental_analyzer = 1;
