--- This query is used by the AWS autoscalers to scale up runner types that
--- have had jobs waiting for them for a significant period of time.
---
--- This query returns the number of jobs per runner type that have been
--- queued for too long, which the autoscalers use to determine how many
--- additional runners to spin up.

with possible_queued_jobs as (
    select
        id,
        run_id
    from default.workflow_job
    where
        status = 'queued'
        and created_at < (
        -- Only consider jobs that have been queued for a significant period of time
            CURRENT_TIMESTAMP() - interval 30 minute
        )
        and created_at > (
        -- Queued jobs are automatically cancelled after this long. Any allegedly pending
        -- jobs older than this are actually bad data
            CURRENT_TIMESTAMP() - interval 3 day
        )
),

queued_jobs as (
    select
        DATE_DIFF(
            'minute',
            job.created_at,
            CURRENT_TIMESTAMP()
        ) as queue_m,
        workflow.repository.owner.login as org,
        workflow.repository.name as repo,
        CONCAT(workflow.name, ' / ', job.name) as name,
        job.html_url,
        IF(
            LENGTH(job.labels) = 0,
            'N/A',
            IF(
                LENGTH(job.labels) > 1,
                job.labels[2],
                job.labels[1]
            )
        ) as runner_label
    from
        default.workflow_job job final
    join default.workflow_run workflow final on workflow.id = job.run_id
    where
        job.id in (select id from possible_queued_jobs)
        and workflow.id in (select run_id from possible_queued_jobs)
        and workflow.repository.owner.login in ('pytorch', 'pytorch-labs')
        and job.status = 'queued'
        /* These two conditions are workarounds for GitHub's broken API. Sometimes */
        /* jobs get stuck in a permanently "queued" state but definitely ran. We can */
        /* detect this by looking at whether any steps executed (if there were, */
        /* obviously the job started running), and whether the workflow was marked as */
        /* complete (somehow more reliable than the job-level API) */
        and LENGTH(job.steps) = 0
        and workflow.status != 'completed'
    order by
        queue_m desc
)

select
    runner_label,
    org,
    repo,
    count(*) as num_queued_jobs,
    min(queue_m) as min_queue_time_minutes,
    max(queue_m) as max_queue_time_minutes
from queued_jobs
group by runner_label, org, repo
order by max_queue_time_minutes desc
settings allow_experimental_analyzer = 1;
