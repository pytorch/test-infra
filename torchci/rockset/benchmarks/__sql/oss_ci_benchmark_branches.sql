--- This query is used to get the list of branches and commits used by different
--- OSS CI benchmark experiments. This powers HUD benchmarks dashboards
SELECT
  DISTINCT w.head_branch,
  w.head_sha,
  w.id,
  FORMAT_ISO8601(
    DATE_TRUNC(: granularity, TIMESTAMP_MILLIS(o.timestamp))
  ) AS event_time,
  o.filename
FROM
  benchmarks.oss_ci_benchmark_v2 o
  LEFT JOIN commons.workflow_run w ON o.workflow_id = w.id
WHERE
  TIMESTAMP_MILLIS(o.timestamp) >= PARSE_DATETIME_ISO8601(: startTime)
  AND TIMESTAMP_MILLIS(o.timestamp) < PARSE_DATETIME_ISO8601(: stopTime)
  AND (
    ARRAY_CONTAINS(
      SPLIT(: filenames, ','),
      o.filename
    )
    OR : filenames = ''
  )
  -- NB: DEVICE (ARCH) is the display format used by HUD when grouping together these two fields
  AND (
    FORMAT(
      '{} ({})',
      o.device,
      IF(
        o.arch IS NULL, 'NVIDIA A100-SXM4-40GB',
        o.arch
      )
    ) = : deviceArch
    OR : deviceArch = ''
  )
  AND o.metric IS NOT NULL
  AND w.html_url LIKE CONCAT('%', : repo, '%')
  AND o.dtype IS NOT NULL
  AND o.device IS NOT NULL
ORDER BY
  w.head_branch,
  event_time DESC