SELECT COUNT(*) AS num
FROM
    push
WHERE
    push.ref IN ('refs/heads/master', 'refs/heads/main')
    AND push.repository.owner.name = 'pytorch'
    AND push.repository.name = 'pytorch'
    AND (
        push.head_commit.message LIKE 'Revert %'
        OR push.head_commit.message LIKE 'Back out%'
    )
    AND push.head_commit.timestamp >= {startTime: DateTime64(3) }
    AND push.head_commit.timestamp < {stopTime: DateTime64(3) }
