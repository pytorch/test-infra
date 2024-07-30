SELECT
  DISTINCT w.head_branch,
  w.head_sha,
  w.id,
  FORMAT_ISO8601(
    DATE_TRUNC(
      : granularity, TIMESTAMP_MILLIS(p.timestamp)
    )
  ) AS event_time,
FROM
  inductor.torch_dynamo_perf_stats_v2 AS p
  LEFT JOIN commons.workflow_run w ON p.workflow_id = w.id
WHERE
  TIMESTAMP_MILLIS(p.timestamp) >= PARSE_DATETIME_ISO8601(: startTime)
  AND TIMESTAMP_MILLIS(p.timestamp) < PARSE_DATETIME_ISO8601(: stopTime)
  AND p.filename LIKE CONCAT(
    '%_', : dtypes, '_', : mode, '_', : device,
    '_performance%'
  )
ORDER BY
  w.head_branch,
  event_time DESC
