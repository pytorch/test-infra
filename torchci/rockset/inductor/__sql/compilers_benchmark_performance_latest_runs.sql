SELECT DISTINCT
  torch_dynamo_perf_stats.workflow_id,
  w.head_branch,
  w.head_sha,  
FROM
 inductor.torch_dynamo_perf_stats LEFT JOIN commons.workflow_run w ON torch_dynamo_perf_stats.workflow_id = w.id
WHERE
  torch_dynamo_perf_stats.filename LIKE '%_performance'
  AND torch_dynamo_perf_stats.filename LIKE CONCAT(
    '%_', : dtypes, '_', : mode, '_', : device,
    '_%'
  )
  AND torch_dynamo_perf_stats.head_branch LIKE :branch
  AND torch_dynamo_perf_stats._event_time >= PARSE_DATETIME_ISO8601(:startTime)
  AND torch_dynamo_perf_stats._event_time < PARSE_DATETIME_ISO8601(:stopTime)
ORDER BY
  workflow_id DESC
LIMIT
  :limit