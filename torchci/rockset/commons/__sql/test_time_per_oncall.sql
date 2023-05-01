With filtered_table as (
  SELECT 
    AVG(
      sum_duration_in_second / occurences
    ) as avg_duration_in_second, 
    oncalls, 
    date, 
    workflow_name, 
    job_name, 
    test_class, 
    test_file, 
    RTRIM(
      LTRIM(
        SPLIT(job_name, '/') [1]
      )
    ) as config_job_name, 
    SUBSTR(
      job_name, 
      STRPOS(job_name, '(') + 1, 
      STRPOS(job_name, ',') - STRPOS(job_name, '(') -1
    ) AS config_shard_name, 
  FROM 
    metrics.aggregated_test_metrics 
  WHERE 
    DATE_TRUNC(
      'DAY', 
      (
        CAST(
          PARSE_DATETIME_ISO8601(date) as date
        )
      )
    ) >= DATE_TRUNC(
      'DAY', 
      PARSE_DATETIME_ISO8601(: startDate)
    ) 
    AND DATE_TRUNC(
      'DAY', 
      (
        CAST(
          PARSE_DATETIME_ISO8601(date) as date
        )
      )
    ) < DATE_TRUNC(
      'DAY', 
      PARSE_DATETIME_ISO8601(: endDate)
    ) 
    AND workflow_id IS NOT NULL 
    AND workflow_run_attempt = 1 
  GROUP BY 
    workflow_name, 
    job_name, 
    test_class, 
    test_file, 
    date, 
    oncalls
), 
filtered_with_costs as (
  SELECT 
    t.avg_duration_in_second as avg_duration_in_second, 
    t.oncalls as oncalls, 
    t.date as date, 
    t.workflow_name as workflow_name, 
    t.job_name as job_name, 
    t.test_class as test_class, 
    t.test_file as test_file, 
    t.config_job_name as config_job_name, 
    t.config_shard_name as config_shard_name, 
    CASE WHEN p.price IS NULL THEN 0 ELSE CAST(p.price AS float) END as price_per_hour 
  FROM 
    filtered_table t 
    LEFT JOIN commons.price_per_config p ON (
      t.config_job_name = p.job_name 
      AND t.config_shard_name = p.shard_name
    )
), 
total_table as (
  SELECT 
    date, 
    workflow_name, 
    SUM(avg_duration_in_second) as total_duration_per_workflow_per_day, 
    SUM(
      price_per_hour * avg_duration_in_second / 60 / 60
    ) as total_price_per_workflow_per_day 
  FROM 
    filtered_with_costs 
  GROUP BY 
    date, 
    workflow_name
), 
filtered_with_oncalls as (
  SELECT 
    * 
  FROM 
    (
      filtered_with_costs CROSS 
      JOIN UNNEST(oncalls AS oncall)
    ) 
  WHERE 
    REPLACE(
      REPLACE(oncall, 'module: ', ''), 
      'oncall: ', 
      ''
    ) LIKE : oncall
), 
filtered_with_oncalls_and_totals as (
  SELECT 
    avg_duration_in_second, 
    oncall, 
    filtered_with_oncalls.date as date, 
    filtered_with_oncalls.workflow_name as workflow_name, 
    job_name, 
    test_class, 
    test_file, 
    total_duration_per_workflow_per_day, 
    total_price_per_workflow_per_day, 
    price_per_hour, 
  FROM 
    filtered_with_oncalls 
    INNER JOIN total_table ON filtered_with_oncalls.date = total_table.date 
    AND filtered_with_oncalls.workflow_name = total_table.workflow_name
), 
t as (
  SELECT 
    REPLACE(
      REPLACE(oncall, 'module: ', ''), 
      'oncall: ', 
      ''
    ) as oncall, 
    workflow_name as workflow_type, 
    SUM(avg_duration_in_second) as time_in_seconds, 
    TRUNC(
      SUM(
        price_per_hour * avg_duration_in_second / 60 / 60
      ), 
      2
    ) as estimated_price_per_run_in_dollars, 
    date as granularity_bucket, 
    TRUNC(
      SUM(avg_duration_in_second) / ARBITRARY(
        -- add noise to avoid divide by 0
        total_duration_per_workflow_per_day + 0.000001
      )* 100, 
      2
    ) as percentage_of_time, 
    TRUNC(
      SUM(
        price_per_hour * avg_duration_in_second / 60 / 60
      ) / ARBITRARY(
        -- add noise to avoid divide by 0
        total_price_per_workflow_per_day + 0.000001
      )* 100, 
      2
    ) as percentage_of_cost, 
  FROM 
    filtered_with_oncalls_and_totals as t 
  WHERE 
    REPLACE(
      REPLACE(t.oncall, 'module: ', ''), 
      'oncall: ', 
      ''
    ) LIKE : oncall 
    AND t.workflow_name LIKE : workflow_type 
  GROUP BY 
    t.oncall, 
    t.date, 
    t.workflow_name
) 
SELECT 
  *, 
FROM 
  t 
ORDER BY 
  time_in_seconds DESC
