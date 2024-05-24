--- This query is used to get the list of branches and commits used by different
--- OSS CI benchmark experiments. This powers HUD benchmarks dashboards
SELECT
  DISTINCT w.head_branch,
  w.head_sha,
  w.id,
  FORMAT_ISO8601(
    DATE_TRUNC(: granularity, o._event_time)
  ) AS event_time,
  o.filename
FROM
  benchmarks.oss_ci_benchmark o
  LEFT JOIN commons.workflow_run w ON o.workflow_id = w.id
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
  w.head_branch,
  event_time DESC