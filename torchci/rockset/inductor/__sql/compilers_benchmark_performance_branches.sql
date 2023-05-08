SELECT DISTINCT
  w.head_branch,
  w.head_sha,
  w.id,
  FORMAT_ISO8601(
    DATE_TRUNC(: granularity, torch_dynamo_perf_stats._event_time)
  ) AS event_time
FROM
  inductor.torch_dynamo_perf_stats LEFT JOIN commons.workflow_run w ON torch_dynamo_perf_stats.workflow_id = w.id
WHERE
  torch_dynamo_perf_stats._event_time >= PARSE_DATETIME_ISO8601(:startTime)
  AND torch_dynamo_perf_stats._event_time < PARSE_DATETIME_ISO8601(:stopTime)
ORDER BY
  w.head_branch,
  event_time DESC