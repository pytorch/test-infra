WITH t AS (
  SELECT 
    AVG(
      sum_duration_in_second / occurences
    ) as avg_duration_in_second, 
    AVG(sum_skipped / occurences) as avg_skipped, 
    oncalls, 
    date, 
    workflow_name, 
    job_name, 
    test_class, 
    test_file, 
    MAX(max_failures) as max_failures, 
    MAX(max_errors) AS max_errors 
  FROM 
    metrics.aggregated_test_metrics 
  GROUP BY 
    workflow_name, 
    job_name, 
    test_class, 
    test_file, 
    date, 
    oncalls
), 
test_runs AS (
  SELECT 
    REPLACE(
      REPLACE(t2.oncall, 'module: ', ''), 
      'oncall: ', 
      ''
    ) as oncall, 
    t.workflow_name as workflow_type, 
    SUM(t.avg_duration_in_second) AS avg_duration_in_second, 
    SUM(t.avg_skipped) AS avg_skipped, 
    MAX(t.max_errors) AS max_errors, 
    MAX(t.max_failures) AS max_failures, 
    t.date as granularity_bucket, 
    t.test_class as test_class, 
    t.test_file as test_file 
  FROM 
    t, 
    UNNEST(t.oncalls AS oncall) AS t2 
  WHERE 
    DATE_TRUNC(
      'DAY', 
      PARSE_DATETIME_ISO8601(t.date)
    ) = DATE_TRUNC(
      'DAY', 
      PARSE_DATETIME_ISO8601(: queryDate)
    ) 
    AND REPLACE(
      REPLACE(t2.oncall, 'module: ', ''), 
      'oncall: ', 
      ''
    ) = : oncall 
    AND t.workflow_name = : workflow_name 
  GROUP BY 
    t2.oncall, 
    t.date, 
    t.test_class, 
    t.test_file, 
    t.workflow_name 
  ORDER BY 
    avg_duration_in_second DESC
) 
SELECT 
  *, 
FROM 
  test_runs 
WHERE 
  avg_duration_in_second >= : thresholdInSecond 
ORDER BY 
  avg_duration_in_second DESC
