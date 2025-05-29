WITH selected_data AS (
  SELECT
    CASE
      WHEN {granularity:String} = 'half_hour' THEN time
      WHEN {granularity:String} = 'hour' THEN dateTrunc('hour', time)
      WHEN {granularity:String} = 'day' THEN dateTrunc('day', time)
      WHEN {granularity:String} = 'week' THEN dateTrunc('week', time)
      WHEN {granularity:String} = 'month' THEN dateTrunc('month', time)
    END AS truncated_time,
    max(max_queue_time) AS aggr_max_queue_time,
    sum(avg_queue_time * total_count) AS weighted_sum,
    sum(total_count) AS aggr_total_count,
    groupArray(histogram) AS al
  FROM fortesting.oss_ci_queue_time_histogram
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
  GROUP BY truncated_time
)

 SELECT
  aggr_max_queue_time AS max_queue_time,
  aggr_total_count AS total_count,
  weighted_sum / aggr_total_count AS avg_queue_time,
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

FROM selected_data
ORDER BY time ASC
