WITH selected_data AS(
SELECT
   CASE
    WHEN {granularity:String} = 'half_hour' THEN   dateTrunc('hour', time) + toIntervalMinute(intDiv(toMinute(time), 30) * 30)
    WHEN {granularity:String} = 'hour' THEN dateTrunc('hour', time)
    WHEN {granularity:String} = 'day' THEN dateTrunc('day', time)
    WHEN {granularity:String} = 'week' THEN dateTrunc('week', time)
    WHEN {granularity:String} = 'month' THEN dateTrunc('month', time)
   END AS truncated_time,
    max(max_queue_time) as max_queue_time,
    sum(total_count) as total_count,
    groupArray(histogram) as al
FROM fortesting.oss_ci_queue_time_histogram
WHERE time > {startTime: DateTime64}
AND time <= {endTime: DateTime64}
AND (
        {items: Array(String)} = []-- machineTypes is null, then fetch all data without job name filter
        OR machine_type IN {items: Array(String)}
    )
AND repo in ({repos: Array(String)})
group by truncated_time
)

SELECT
   selected_data.max_queue_time,
   selected_data.total_count,
   selected_data.truncated_time as time,
   arrayMap(i -> arraySum(arrayMap(arr -> arr[i], selected_data.al)), range(1, length(al[1]))) AS data
FROM selected_data
order by truncated_time asc
