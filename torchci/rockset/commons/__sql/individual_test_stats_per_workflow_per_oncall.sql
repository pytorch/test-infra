WITH test_runs AS (
  SELECT 
REPLACE(REPLACE(t2.oncall, 'module: ', ''),'oncall: ','') as oncall,
t.workflow_name as workflow_type,
SUM(t.avg_duration_in_second) AS avg_duration_in_second,
t.date as granularity_bucket,
t.test_class as test_class,
t.test_file as test_file,
t.avg_skipped as avg_skipped,
t.max_errors as max_errors,
t.max_failures as max_failures,
t.avg_tests as avg_tests
FROM
metrics.aggregated_test_metrics AS t,
UNNEST(t.oncalls AS oncall) AS t2
WHERE
DATE_TRUNC('DAY', PARSE_DATETIME_ISO8601(t.date)) = DATE_TRUNC('DAY', PARSE_DATETIME_ISO8601(:queryDate)) AND
  REPLACE(REPLACE(t2.oncall, 'module: ', ''),'oncall: ','') = :oncall AND
  t.workflow_name = :workflow_name 
GROUP BY
  t2.oncall,
  t.date,
  t.test_class,
  t.test_file,
  t.avg_skipped,
  t.max_errors,
  t.max_failures,
  t.workflow_name,
  t.avg_tests
ORDER BY
avg_duration_in_second DESC
)

SELECT
    *
FROM
    test_runs
WHERE
    avg_duration_in_second >= :thresholdInSecond
ORDER BY
    avg_duration_in_second DESC
