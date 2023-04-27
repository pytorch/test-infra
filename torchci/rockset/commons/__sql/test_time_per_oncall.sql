With avg_table as (
  SELECT 
    AVG(
      sum_duration_in_second / occurences
    ) as avg_duration_in_second, 
    oncalls, 
    date, 
    workflow_name, 
    job_name, 
    test_class, 
    test_file 
  FROM 
    metrics.aggregated_test_metrics 
  WHERE 
    workflow_run_attempt = 1
    AND DATE_TRUNC(
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
total_table as (
  SELECT 
    date, 
    workflow_name, 
    SUM(avg_duration_in_second) as total_duration_per_workflow_per_day 
  FROM 
    avg_table 
  GROUP BY 
    date, 
    workflow_name
), 
avg_and_oncalls as (
  SELECT 
    * 
  FROM 
    (
      avg_table CROSS 
      JOIN UNNEST(oncalls AS oncall)
    ) 
  WHERE 
    REPLACE(
      REPLACE(oncall, 'module: ', ''), 
      'oncall: ', 
      ''
    ) LIKE : oncall
), 
t as (
  SELECT 
    avg_duration_in_second, 
    oncall, 
    avg_and_oncalls.date as date, 
    avg_and_oncalls.workflow_name as workflow_name, 
    job_name, 
    test_class, 
    test_file, 
    total_duration_per_workflow_per_day 
  FROM 
    avg_and_oncalls 
    INNER JOIN total_table ON avg_and_oncalls.date = total_table.date 
    AND avg_and_oncalls.workflow_name = total_table.workflow_name
) 
SELECT 
  REPLACE(
    REPLACE(oncall, 'module: ', ''), 
    'oncall: ', 
    ''
  ) as oncall, 
  workflow_name as workflow_type, 
  SUM(avg_duration_in_second) as time_in_seconds, 
  date as granularity_bucket, 
  TRUNC(
    SUM(avg_duration_in_second) / ARBITRARY(
      total_duration_per_workflow_per_day
    )* 100, 
    2
  ) as percentage 
FROM 
  t 
WHERE 
  -- CAST(PARSE_DATETIME_ISO8601(t.date) as date) < PARSE_DATETIME_ISO8601(:endDate) AND
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
ORDER BY 
  time_in_seconds DESC
