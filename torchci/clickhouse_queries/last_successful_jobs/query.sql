select
    min(
        DATE_DIFF('second', job.created_at, CURRENT_TIMESTAMP())
    ) as last_success_seconds_ago
from
    -- No final because info is unlikely to change after conclusion gets set
    default .workflow_job job
where
    job.name in {jobNames: Array(String) }
    and job.conclusion = 'success'
    and job.head_branch = 'main'
    and job.html_url like '%/pytorch/pytorch/%' -- proxy for workflow.repository.'full_name' = 'pytorch/pytorch'
group by
    job.head_sha
having
    count(distinct job.name) >= LENGTH({jobNames: Array(String) })
order by
    last_success_seconds_ago
limit
    1
