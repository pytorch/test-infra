select
    SUM(LENGTH(p.commits)) as num
from
    push p
where
    p.repository.full_name = 'pytorch/pytorch'
    and p.ref = 'refs/heads/main'
    AND p.head_commit.'timestamp' >= {startTime: DateTime64(3)}
    AND p.head_commit.'timestamp' < {stopTime: DateTime64(3)}
