with labeled_pr as (
    select
        test.value.name,
        p.number,
        p.head.ref head_ref,
        p.head.sha,
        p.base.ref base_ref
    from
        commons.pull_request p,
        unnest(p.labels as value) as test
    group by
        p.number,
        test.value.name,
        p.head.ref,
        p.head.sha,
        p.base.ref
)
select
    *
from
    labeled_pr
where
    name = :label
    and sha = :sha
    
