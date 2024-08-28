SELECT
    formatDateTime(
            CASE
                WHEN {granularity:String} = 'minute' THEN toStartOfMinute(q.time)
                WHEN {granularity:String} = 'hour' THEN toStartOfHour(q.time)
                WHEN {granularity:String} = 'day' THEN toStartOfDay(q.time)
                WHEN {granularity:String} = 'week' THEN toStartOfWeek(q.time)
                WHEN {granularity:String} = 'month' THEN toStartOfMonth(q.time)
                WHEN {granularity:String} = 'year' THEN toStartOfYear(q.time)
                ELSE toStartOfDay(q.time)  -- Default to day if granularity is not recognized
                END,
            '%Y-%m-%dT%H:%i:%s'
    ) AS granularity_bucket,
    /* misnomer, this is the max queue time, not the avg queue time */
    avg(q.avg_queue_s) as avg_queue_s,
    q.machine_type
FROM
    queue_times_historical q
WHERE
    q.time >= parseDateTimeBestEffort({startTime:String}) AND q.time < parseDateTimeBestEffort({stopTime:String})
GROUP BY
    granularity_bucket,
    q.machine_type
HAVING
    /* filter out weird GH API bugs */
    avg(q.count) > 5
ORDER BY
    granularity_bucket ASC