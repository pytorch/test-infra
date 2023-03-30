SELECT DISTINCT
  workflow_id,
FROM
 inductor.torch_dynamo_perf_stats
WHERE
  filename LIKE '%_performance'
  AND filename LIKE CONCAT(
    '%_', : dtypes, '_', : mode, '_', : device,
    '_%'
  )
  AND torch_dynamo_perf_stats.head_branch LIKE :branch
  AND _event_time >= PARSE_DATETIME_ISO8601(:startTime)
  AND _event_time < PARSE_DATETIME_ISO8601(:stopTime)
ORDER BY
  workflow_id DESC
LIMIT
  :limit