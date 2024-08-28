-- !!! Query is not converted to CH syntax yet.  Delete this line when it gets converted
--- This query is used by HUD benchmarks dashboards to get the list of experiment names
SELECT DISTINCT
  o.filename,  
  o.name,  
  o.metric,
  o.dtype,
  o.device,
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
  AND o.metric IS NOT NULL
  AND w.html_url LIKE CONCAT('%', : repo, '%')
  AND o.dtype IS NOT NULL
  AND o.device IS NOT NULL
ORDER BY
  o.filename,  
  o.name,
  o.metric,
  o.dtype,
  o.device