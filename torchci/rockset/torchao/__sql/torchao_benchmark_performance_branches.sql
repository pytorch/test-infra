SELECT
  DISTINCT head_branch,
  head_sha,
  FORMAT_ISO8601(
    DATE_TRUNC(
      : granularity, _event_time
    )
  ) AS event_time,
FROM
  inductor.torchao_perf_stats
WHERE
  torchao_perf_stats._event_time >= PARSE_DATETIME_ISO8601(: startTime)
  AND torchao_perf_stats._event_time < PARSE_DATETIME_ISO8601(: stopTime)
  AND torchao_perf_stats.filename LIKE '%_performance'
  AND torchao_perf_stats.filename LIKE CONCAT(
    '%_', : dtypes, '_', : mode, '_', : device,
    '_%'
  )
ORDER BY
  head_branch,
  event_time DESC
