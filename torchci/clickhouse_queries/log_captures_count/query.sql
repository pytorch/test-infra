with jobs as (
    select
        j.torchci_classification.line as example,
        j.torchci_classification.captures as captures,
        j.run_id
    from
        default.workflow_job j final
    where
        j.id in (
            select id from materialized_views.workflow_job_by_created_at
            where created_at >= {startTime: DateTime64(3)} and created_at < {stopTime: DateTime64(3)}
        )
        and j.conclusion in ('cancelled', 'failure', 'time_out')
)
select
    COUNT(*) as num,
    any(example) as example,
    captures as captures
from
    jobs j
    join default.workflow_run w final on w.id = j.run_id
where
    w.id in (select run_id from jobs)
    and w.head_branch = 'main'
    and w.head_repository.'full_name' = 'pytorch/pytorch'
    AND w.event != 'workflow_run'
    AND w.event != 'repository_dispatch'
group by
    captures
order by
    COUNT(*) desc
