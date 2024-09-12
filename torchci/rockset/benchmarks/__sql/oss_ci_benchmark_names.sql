--- This query is used by HUD benchmarks dashboards to get the list of experiment names
SELECT DISTINCT
  o.filename,  
  o.name,  
  o.metric,
  o.dtype,
  o.device,
  -- NB: Default to NVIDIA A100-SXM4-40GB for old records without arch column
  IF(o.arch IS NULL, 'NVIDIA A100-SXM4-40GB', o.arch) as arch,
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