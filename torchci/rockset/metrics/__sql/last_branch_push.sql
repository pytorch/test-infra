select
    DATE_DIFF('second', push._event_time, CURRENT_TIMESTAMP()) as push_seconds_ago
from
    push
where
    push.ref = :branch
    AND push.repository.owner.name = 'pytorch'
    AND push.repository.name = 'pytorch'
    AND push.head_commit is not null
order by
    push._event_time desc
limit
    1
