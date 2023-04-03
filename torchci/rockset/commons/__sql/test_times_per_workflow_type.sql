SELECT
t.workflow_name as workflow_type,
SUM(t.avg_duration_in_second) as time_in_seconds,
t.date AS granularity_bucket
FROM
metrics.aggregated_test_metrics AS t
WHERE
CAST(PARSE_DATETIME_ISO8601(t.date) as date) >= PARSE_DATETIME_ISO8601(:startDate) AND
t.workflow_name != 'inductor' AND
t.workflow_name != 'unstable'
GROUP BY
  t.date,
  t.workflow_name
