select
    j.name as job_name,
    round(
        avg(
            DATE_DIFF('second', step.started_at, step.completed_at)
        ) / 60,
        2
    ) as duration_min,
    step.name as step_name,
    count(*) as count
from
    default .workflow_job j array
    join j.steps as step
where
    j.created_at >= {startTime: DateTime64(3)}
    and j.created_at < {stopTime: DateTime64(3)}
    and step.conclusion = 'success'
    and j.name like '% / build'
    and j.workflow_name in ('pull', 'trunk', 'periodic', 'slow', 'inductor')
    and step.name in ('Build', 'Pull docker image', 'Checkout PyTorch')
    and j.html_url like '%/pytorch/pytorch/%'
group by
    job_name,
    step_name
having
    count(*) > 10
