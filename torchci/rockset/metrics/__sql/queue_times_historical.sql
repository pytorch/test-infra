SELECT
    FORMAT_ISO8601(
        DATE_TRUNC(
            :granularity,
            q._event_time AT TIME ZONE :timezone
        )
    ) AS granularity_bucket,
    /* misnomer, this is the max queue time, not the avg queue time */
    AVG(q.avg_queue_s) as avg_queue_s,
    q.machine_type,
FROM
    metrics.queue_times_historical q
WHERE
    q._event_time >= PARSE_DATETIME_ISO8601(:startTime)
    AND q._event_time < PARSE_DATETIME_ISO8601(:stopTime)
GROUP BY
    granularity_bucket,
    q.machine_type
HAVING
    /* filter out weird GH API bugs */
    AVG(q.count) > 5
ORDER BY
    granularity_bucket ASC
