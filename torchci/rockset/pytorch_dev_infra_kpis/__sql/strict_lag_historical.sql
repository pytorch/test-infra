select
    AVG(
        DATE_DIFF(
            'minute',
            PARSE_Timestamp_ISO8601(push.head_commit.timestamp),
            push._event_time
        ) / 60.0
    ) as diff_hr,
    DATE_TRUNC(:granularity, push._event_time) AS push_time,
from
    push
where
    push._event_time >= PARSE_DATETIME_ISO8601(:startTime)
    AND push._event_time < PARSE_DATETIME_ISO8601(:stopTime)
    and push.ref like 'refs/heads/viable/strict'
group by
    push_time
order by
    push_time
