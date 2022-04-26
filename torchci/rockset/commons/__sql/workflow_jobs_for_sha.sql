select
    w.name,
    w.conclusion
from
    commons.workflow_job w
    inner join (
        select
            max(job._event_time),
            name
        from
            commons.workflow_job job
        group by
            name
    ) max_time on max_time.name = w.name
where
    w.head_sha = :sha
group by
    name,
    conclusion
