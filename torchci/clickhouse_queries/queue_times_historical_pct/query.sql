SELECT
    toStartOfHour(
        toDateTime(q.time, {timezone: String})
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
    misc.queue_times_24h_stats q
WHERE
    q.time
    >= toStartOfHour(
        toDateTime({startTime: DateTime64(3)}, {timezone: String})
    )
    AND q.time
    < toStartOfHour(
        toDateTime({stopTime: DateTime64(3)}, {timezone: String})
    )
    AND has({workersTypes: Array(String)}, q.machine_type)
ORDER BY
    granularity_bucket, machine_type ASC
