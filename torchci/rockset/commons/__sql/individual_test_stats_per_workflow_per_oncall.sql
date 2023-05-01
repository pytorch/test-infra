WITH filtered_table AS (
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
    MAX(max_errors) AS max_errors, 
    RTRIM(
      LTRIM(
        SPLIT(job_name, '/') [1]
      )
    ) as config_job_name, 
    SUBSTR(
      job_name, 
      STRPOS(job_name, '(') + 1, 
      STRPOS(job_name, ',') - STRPOS(job_name, '(') -1
    ) AS config_shard_name 
  FROM 
    metrics.aggregated_test_metrics 
  WHERE 
    workflow_run_attempt = 1 
    AND workflow_id IS NOT NULL 
  GROUP BY 
    workflow_name, 
    job_name, 
    test_class, 
    test_file, 
    date, 
    oncalls
), 
filtered_with_costs AS (
  SELECT 
    t.avg_duration_in_second as avg_duration_in_second, 
    t.avg_skipped, 
    t.oncalls, 
    t.date, 
    t.workflow_name, 
    t.job_name, 
    t.test_class, 
    t.test_file, 
    t.max_failures AS max_failures, 
    t.max_errors AS max_errors, 
    CASE WHEN p.price IS NULL THEN 0 ELSE CAST(p.price AS float) * t.avg_duration_in_second / 60 / 60 END as estimated_price 
  FROM 
    filtered_table as t 
    LEFT JOIN commons.price_per_config p ON (
      t.config_job_name = p.job_name 
      AND t.config_shard_name = p.shard_name
    )
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
    TRUNC(
      SUM(t.estimated_price), 
      2
    ) AS estimated_price_per_run_in_dollars, 
    MAX(t.max_errors) AS max_errors, 
    MAX(t.max_failures) AS max_failures, 
    t.date as granularity_bucket, 
    t.test_class as test_class, 
    t.test_file as test_file 
  FROM 
    filtered_with_costs as t, 
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
