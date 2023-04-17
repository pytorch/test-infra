select
    COUNT(*) as num,
    ARBITRARY(j.torchci_classification.line) as example,
    j.torchci_classification.captures as captures,
    ARRAY_JOIN(j.torchci_classification.captures, '%') as search_string
from
    workflow_job j
    join workflow_run w on w.id = j.run_id
where
    j._event_time >= PARSE_TIMESTAMP_ISO8601(:startTime)
    and j._event_time < PARSE_TIMESTAMP_ISO8601(:stopTime)
    and w.head_branch = 'main'
    and w.head_repository.full_name = 'pytorch/pytorch'
    and j.conclusion in ('cancelled', 'failure', 'time_out')
    AND w.event != 'workflow_run'
    AND w.event != 'repository_dispatch'
group by
    j.torchci_classification.captures
order by
    COUNT(*) desc
