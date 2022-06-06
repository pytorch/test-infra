WITH master as (
    SELECT
        PARSE_TIMESTAMP_ISO8601(push.head_commit.timestamp) as master
    FROM
        push
    WHERE
        push.ref = 'refs/heads/master'
        AND push.repository.owner.name = 'pytorch'
        AND push.repository.name = 'pytorch'
        AND push.head_commit is not null
    ORDER BY
        push._event_time desc
    LIMIT
        1
), strict as (
    SELECT
        PARSE_TIMESTAMP_ISO8601(push.head_commit.timestamp) as strict
    FROM
        push
    WHERE
        push.ref = 'refs/heads/viable/strict'
        AND push.repository.owner.name = 'pytorch'
        AND push.repository.name = 'pytorch'
        AND push.head_commit is not null
    ORDER BY
        push._event_time desc
    LIMIT
        1
)
SELECT
    DATE_DIFF('second', strict, master) as strict_lag_sec
FROM
    master,
    strict
