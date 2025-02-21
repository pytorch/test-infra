--- This query is used by HUD metrics page to get the list of queued jobs
with possible_queued_jobs as (
    select
        id,
        run_id
    from default.workflow_job -- FINAL not needed since we just use this to filter a table that has already been FINALed
    where
        status = 'queued'
        and created_at < (CURRENT_TIMESTAMP() - interval 5 minute)
        and created_at > (CURRENT_TIMESTAMP() - interval 1 week)
)

select
    DATE_DIFF(
        'second',
        job.created_at,
        CURRENT_TIMESTAMP()
    ) as queue_s,
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
    ) as machine_type
from
    default.workflow_job job final
join default.workflow_run workflow final on workflow.id = job.run_id
where
    job.id in (select id from possible_queued_jobs)
    and workflow.id in (select run_id from possible_queued_jobs)
    and workflow.repository.'full_name' = 'pytorch/pytorch'
    and job.status = 'queued'
    /* These two conditions are workarounds for GitHub's broken API. Sometimes */
    /* jobs get stuck in a permanently "queued" state but definitely ran. We can */
    /* detect this by looking at whether any steps executed (if there were, */
    /* obviously the job started running), and whether the workflow was marked as */
    /* complete (somehow more reliable than the job-level API) */
    and LENGTH(job.steps) = 0
    and workflow.status != 'completed'
order by
    queue_s desc
settings allow_experimental_analyzer = 1;
