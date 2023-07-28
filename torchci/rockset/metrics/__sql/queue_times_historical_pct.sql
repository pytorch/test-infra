SELECT
    FORMAT_ISO8601(
        DATE_TRUNC(
            'hour',
            q._event_time AT TIME ZONE :timezone
        )
    ) AS granularity_bucket,
    q.queue_s_max,
    q.queue_s_p99,
    q.queue_s_p95,
    q.queue_s_p90,
    q.queue_s_p80,
    q.queue_s_p50,
    q.queue_s_avg,
    q.machine_type
FROM
    metrics.queue_times_24h_stats q
WHERE
    q._event_time >= DATE_TRUNC('hour', PARSE_DATETIME_ISO8601(:startTime) AT TIME ZONE :timezone)
    AND q._event_time < DATE_TRUNC('hour', PARSE_DATETIME_ISO8601(:stopTime) AT TIME ZONE :timezone)
    AND ARRAY_CONTAINS(SPLIT(:workersTypes, ','), q.machine_type)
ORDER BY
    granularity_bucket, machine_type ASC
