SELECT
    FORMAT_TIMESTAMP('%m-%d-%y', DATE_TRUNC('week', push._event_time)) AS week_bucket,
    COUNT(*) as num
FROM
    push
WHERE
    push.ref = 'refs/heads/master'
    AND push.repository.owner.name = 'pytorch'
    AND push.repository.name = 'pytorch'
    AND (
        push.head_commit.message LIKE 'Revert D%'
        OR push.head_commit.message LIKE 'Back out%'
    )
    AND push._event_time >= PARSE_DATETIME_ISO8601(:startTime)
group by
    week_bucket
order by
    week_bucket
