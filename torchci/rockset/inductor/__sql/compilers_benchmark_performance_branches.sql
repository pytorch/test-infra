SELECT DISTINCT
  w.head_branch  
FROM
  inductor.torch_dynamo_perf_stats LEFT JOIN commons.workflow_run w ON torch_dynamo_perf_stats.workflow_id = w.id
WHERE
  torch_dynamo_perf_stats._event_time >= PARSE_DATETIME_ISO8601(:startTime)
  AND torch_dynamo_perf_stats._event_time < PARSE_DATETIME_ISO8601(:stopTime)
  AND w.head_branch != 'master'
ORDER BY
  w.head_branch