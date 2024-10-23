-- Elapsed seconds since the last commit was pushed to pytorch/pytorch's main branch

select
    DATE_DIFF('second', head_commit.timestamp, CURRENT_TIMESTAMP()) as push_seconds_ago
from
    push
where
    push.ref = { branch : String }
    AND push.repository.owner.name = 'pytorch'
    AND push.repository.name = 'pytorch'
order by
    push.head_commit.timestamp desc
limit
    1
