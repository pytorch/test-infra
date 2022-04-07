with successful_jobs as (
    select
        DATE_DIFF(
            'second',
            job._event_time,
            CURRENT_TIMESTAMP()
        ) as last_success_seconds_ago,
        job.head_sha,
        job.name name
    from
        workflow_job job
        JOIN workflow_run workflow on workflow.id = job.run_id
    where
        workflow.repository.full_name = 'pytorch/pytorch'
        AND workflow.head_branch = 'master'
        AND job.conclusion = 'success'
        AND ARRAY_CONTAINS(SPLIT(:jobNames, ','), job.name)
    order by
        job._event_time desc
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
    distinct_names >= LENGTH(SPLIT(:jobNames, ','))
order by
    seconds_ago
limit
    1
