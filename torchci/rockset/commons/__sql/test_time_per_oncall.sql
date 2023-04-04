SELECT
REPLACE(REPLACE(t2.oncall, 'module: ', ''),'oncall: ','') as oncall,
t.workflow_name as workflow_type,
SUM(t.avg_duration_in_second) as time_in_seconds,
t.date as granularity_bucket
FROM
metrics.aggregated_test_metrics AS t,
UNNEST(t.oncalls AS oncall) AS t2
WHERE
CAST(PARSE_DATETIME_ISO8601(t.date) as date) >= PARSE_DATETIME_ISO8601(:startDate) AND
  REPLACE(REPLACE(t2.oncall, 'module: ', ''),'oncall: ','') = :oncall
GROUP BY
  t2.oncall,
  t.date,
  t.workflow_name
