WITH workers AS (
    SELECT
        DISTINCT(qts.machine_type) as machine_type,
    FROM
        metrics.queue_times_24h_stats qts
    WHERE
        qts._event_time >= PARSE_DATETIME_ISO8601(:startTime) AT TIME ZONE :timezone
        AND qts._event_time < PARSE_DATETIME_ISO8601(:stopTime) AT TIME ZONE :timezone
)
SELECT
    w.machine_type
FROM
    workers w
ORDER BY
    w.machine_type ASC
;
