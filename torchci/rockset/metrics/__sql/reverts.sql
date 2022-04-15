SELECT
    COUNT(*) as num
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
    AND push._event_time >= PARSE_DATETIME_ISO8601(:startTime)
    AND push._event_time < PARSE_DATETIME_ISO8601(:stopTime)
