SELECT
  DISTINCT w.head_branch,
  w.head_sha,
  w.id,
  FORMAT_ISO8601(
    DATE_TRUNC(
      : granularity, torchao_perf_stats._event_time
    )
  ) AS event_time,
FROM
  inductor.torchao_perf_stats
  LEFT JOIN commons.workflow_run w ON torchao_perf_stats.workflow_id = w.id
WHERE
  torchao_perf_stats._event_time >= PARSE_DATETIME_ISO8601(: startTime)
  AND torchao_perf_stats._event_time < PARSE_DATETIME_ISO8601(: stopTime)
  AND torchao_perf_stats.filename LIKE '%_performance'
  AND torchao_perf_stats.filename LIKE CONCAT(
    '%_', : dtypes, '_', : mode, '_', : device,
    '_%'
  )
ORDER BY
  w.head_branch,
  event_time DESC
