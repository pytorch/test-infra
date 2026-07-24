WITH selected_data AS (
  SELECT
    multiIf(
        {granularity:String} = 'half_hour', time,
        {granularity:String} = 'hour', dateTrunc('hour', time),
        {granularity:String} = 'day', dateTrunc('day', time),
        {granularity:String} = 'week', dateTrunc('week', time),
        {granularity:String} = 'month', dateTrunc('month', time),
        time  -- default fallback
    ) AS truncated_time,
    multiIf(
        {granularity:String} = 'half_hour', 1,
        {granularity:String} = 'hour', 2,
        {granularity:String} = 'day', 48,
        {granularity:String} = 'week', 336,
        {granularity:String} = 'month', 1440,
        1
    ) AS time_divisor,
    job_name,
    max(max_queue_time) AS max_queue_time,
    sum(avg_queue_time * total_count) AS sumi,
    sum(total_count) AS count_sum,
    groupArray(histogram) AS partial_al
  FROM misc.oss_ci_queue_time_histogram
  WHERE time > {startTime: DateTime64}
    AND time <= {endTime: DateTime64}
    AND repo IN ({repos: Array(String)})
    AND (
      {jobNames: Array(String)} = [] OR job_name IN { jobNames: Array(String)}
    )
    AND (
      {workflowNames: Array(String)} = [] OR workflow_name IN {workflowNames: Array(String)}
    )
    AND (
      {machineTypes: Array(String)} = [] OR machine_type IN {machineTypes: Array(String)}
    )
    AND (
    {runnerLabels: Array(String)} = [] OR hasAny(runner_labels, {runnerLabels: Array(String)})
  )
  GROUP BY truncated_time, job_name, time_divisor
),
final AS (
  SELECT
  truncated_time,
  time_divisor,
  max(max_queue_time) AS aggr_max_queue_time,
  sum(sumi * count_sum) AS weighted_sum,
  sum(count_sum) AS total_count_sum,
  groupArray(arrayMap(
    i -> arraySum(arrayMap(arr -> arr[i], partial_al)),
    range(1, length(partial_al[1]))
  )) AS al
  FROM selected_data
  group by truncated_time, time_divisor
)
SELECT
  aggr_max_queue_time AS max_queue_time,
  total_count_sum,
  time_divisor,
  total_count_sum / time_divisor AS avg_queued_job_count,
  weighted_sum / total_count_sum AS avg_queue_time,

  truncated_time AS time,

  arrayMap(
    i -> arraySum(arrayMap(arr -> arr[i], al)),
    range(1, length(al[1]))
  ) AS data,

  round(arrayReduce('quantile(0.5)',
    arrayFlatten(arrayMap(
      (x, i) -> arrayResize([0], toUInt32(x), i),
      arrayMap(i -> arraySum(arrayMap(arr -> arr[i], al)), range(1, length(al[1]))),
      arrayEnumerate(arrayMap(i -> arraySum(arrayMap(arr -> arr[i], al)), range(1, length(al[1]))))
    )))
  ) AS p50_index,

  round(arrayReduce('quantile(0.9)',
    arrayFlatten(arrayMap(
      (x, i) -> arrayResize([0], toUInt32(x), i),
      arrayMap(i -> arraySum(arrayMap(arr -> arr[i], al)), range(1, length(al[1]))),
      arrayEnumerate(arrayMap(i -> arraySum(arrayMap(arr -> arr[i], al)), range(1, length(al[1]))))
    )))
  ) AS p90_index,

  round(arrayReduce('quantile(0.2)',
    arrayFlatten(arrayMap(
      (x, i) -> arrayResize([0], toUInt32(x), i),
      arrayMap(i -> arraySum(arrayMap(arr -> arr[i], al)), range(1, length(al[1]))),
      arrayEnumerate(arrayMap(i -> arraySum(arrayMap(arr -> arr[i], al)), range(1, length(al[1]))))
    )))
  ) AS p20_index
FROM final
ORDER BY time ASC
