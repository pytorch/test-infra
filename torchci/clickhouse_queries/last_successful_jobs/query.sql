with successful_jobs as (
    select
        DATE_DIFF(
            'second',
            job.created_at,
            CURRENT_TIMESTAMP()
        ) as last_success_seconds_ago,
        job.head_sha as head_sha,
        job.name as name
    from
        default.workflow_job job final
        JOIN default.workflow_run workflow final on workflow.id = job.run_id
    where
        workflow.repository.'full_name' = 'pytorch/pytorch'
        AND workflow.head_branch IN ('master', 'main')
        AND job.conclusion = 'success'
        AND job.name in {jobNames: Array(String)}
    order by
        job.created_at DESC
),
successful_commits as (
    select
        min(last_success_seconds_ago) seconds_ago,
        count(DISTINCT name) distinct_names,
        head_sha
    from
        successful_jobs
    group by
        head_sha
)
select
    seconds_ago as last_success_seconds_ago
from
    successful_commits
where
    distinct_names >= LENGTH({jobNames: Array(String)})
order by
    seconds_ago
limit
    1
