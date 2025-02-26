select
    date_trunc({granularity: String}, j.started_at) as bucket,
    round(avg(date_diff('second', j.started_at, j.completed_at)), 2)
        as duration_sec,
    j.name as job_name
from default.workflow_job j
where
    j.started_at >= {startTime: DateTime64(3) }
    and j.started_at < {stopTime: DateTime64(3) }
    and j.conclusion = 'success'
    and j.html_url like '%pytorch/pytorch%'
    and j.workflow_name in ('pull', 'trunk', 'periodic', 'inductor', 'slow')
    and j.name like '% / build'
group by bucket, job_name
having count(*) > 10
order by bucket, job_name
