--- This query is used by HUD benchmarks dashboards to get the list of experiment names
SELECT DISTINCT
  o.filename,  
  o.name,
  o.mode
FROM
  benchmarks.oss_ci_benchmark o
WHERE
  o._event_time >= PARSE_DATETIME_ISO8601(: startTime)
  AND o._event_time < PARSE_DATETIME_ISO8601(: stopTime)
  AND (
    ARRAY_CONTAINS(
      SPLIT(: filenames, ','),
      o.filename
    )
    OR : filenames = ''
  )
ORDER BY
  o.filename,  
  o.name