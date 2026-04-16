SELECT SUM(LENGTH(p.commits)) AS num
FROM
    push p
WHERE
    p.repository.full_name = 'pytorch/pytorch'
    AND p.ref = 'refs/heads/main'
    AND p.head_commit.'timestamp' >= {startTime: DateTime64(3)}
    AND p.head_commit.'timestamp' < {stopTime: DateTime64(3)}
