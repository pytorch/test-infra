WITH test_runs AS (
  SELECT 
    workflow_run.name AS workflow_name, 
    workflow_job.name AS job_name, 
    test_run_summary.invoking_file AS test_file, 
    test_run_summary.classname AS test_class, 
    test_run_summary.tests AS tests, 
    test_run_summary.errors AS errors, 
    test_run_summary.failures AS failures, 
    test_run_summary.skipped AS skipped, 
    test_run_summary.time AS duration_in_second, 
  FROM 
    commons.test_run_summary 
    JOIN commons.workflow_run on test_run_summary.workflow_id = CAST(workflow_run.id as string) 
    JOIN commons.workflow_job on test_run_summary.job_id = workflow_job.id 
  WHERE 
    test_run_summary._event_time >= PARSE_DATETIME_ISO8601(: startTime) 
    AND test_run_summary._event_time < PARSE_DATETIME_ISO8601(: stopTime) 
    AND test_run_summary.workflow_run_attempt = 1 
    AND workflow_run.name = : workflowName 
    AND workflow_run.head_branch = 'master' 
    AND test_run_summary.invoking_file LIKE : testFile 
    AND test_run_summary.classname LIKE : testClass
), 
aggregated_test_runs AS (
  SELECT 
    workflow_name, 
    job_name, 
    test_file, 
    test_class, 
    CAST(
      AVG(duration_in_second) AS int
    ) avg_duration_in_second, 
    CAST(
      AVG(tests) AS int
    ) AS avg_tests, 
    MAX(failures) AS max_failures, 
    MAX(errors) AS max_errors, 
    CAST(
      AVG(skipped) AS int
    ) AS avg_skipped, 
  FROM 
    test_runs 
  GROUP BY 
    workflow_name, 
    job_name, 
    test_file, 
    test_class
) 
SELECT 
  * 
FROM 
  aggregated_test_runs 
WHERE 
  avg_duration_in_second >= : thresholdInSecond 
ORDER BY 
  avg_duration_in_second DESC
