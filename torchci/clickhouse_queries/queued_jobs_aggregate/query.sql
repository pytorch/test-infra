--- This query is used by the AWS autoscalers to scale up runner types that
--- have had jobs waiting for them for a significant period of time.
---
--- This query returns the number of jobs per runner type that have been
--- queued for too long, which the autoscalers use to determin how many
--- additional runners to spin up.

with possible_queued_jobs as (
  select id, run_id
  from default.workflow_job
  where
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
 queued_jobs as (
    SELECT
    DATE_DIFF(
        'minute',
        job.created_at,
        CURRENT_TIMESTAMP()
    ) AS queue_m,
    workflow.repository.owner.login as org,
    workflow.repository.full_name as full_repo,
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
    default.workflow_job job final
    JOIN default.workflow_run workflow final ON workflow.id = job.run_id
    WHERE
    job.id in (select id from possible_queued_jobs)
    and workflow.id in (select run_id from possible_queued_jobs)
    and workflow.repository.owner.login in ('pytorch', 'pytorch-labs')
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
select
  runner_label,
  org,
  full_repo,
  count(*) as num_queued_jobs,
  min(queue_m) as min_queue_time_min,
  max(queue_m) as max_queue_time_min
from queued_jobs
group by runner_label, org, full_repo
order by max_queue_time_min desc
settings allow_experimental_analyzer = 1;