WITH sum_table AS (SELECT 
  t.workflow_name as workflow_type, 
  SUM(
    t.sum_duration_in_second
  ) as time_in_seconds, 
  t.date AS granularity_bucket,
  t.workflow_id
FROM 
  metrics.aggregated_test_metrics AS t 
WHERE 
  CAST(
    PARSE_DATETIME_ISO8601(t.date) as date
  ) >= PARSE_DATETIME_ISO8601(: startDate) 
  AND t.workflow_name != 'inductor' 
  AND t.workflow_name != 'unstable' 
  AND t.workflow_id IS NOT NULL
GROUP BY 
  t.date, 
  t.workflow_name,
  t.workflow_id
)
SELECT
  workflow_type, 
  AVG(
    time_in_seconds
  ) as time_in_seconds, 
  granularity_bucket
FROM 
  sum_table 
GROUP BY 
  granularity_bucket,
  workflow_type