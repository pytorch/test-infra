SELECT
    DATE_TRUNC(
        {granularity: String},
        q.time
    ) AS granularity_bucket,
    /* misnomer, this is the max queue time, not the avg queue time */
    AVG(q.avg_queue_s) AS avg_queue_s,
    q.machine_type
FROM
    default.queue_times_historical q
WHERE
    q.time >= {startTime: DateTime64(9)}
    AND q.time < {stopTime: DateTime64(9)}
GROUP BY
    granularity_bucket,
    q.machine_type
HAVING
    /* filter out weird GH API bugs */
    AVG(q.count) > 5
ORDER BY
    granularity_bucket ASC
