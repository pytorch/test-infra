select
    SUM(LENGTH(p.commits)) as num
from
    push p
where
    p.repository.full_name = 'pytorch/pytorch'
    and p.ref = 'refs/heads/main'
    AND p._event_time >= PARSE_DATETIME_ISO8601(:startTime)
    AND p._event_time < PARSE_DATETIME_ISO8601(:stopTime)