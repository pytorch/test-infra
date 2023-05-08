SELECT DISTINCT
    test_run_summary.workflow_id,
    test_run_summary.job_id,
    test_run_summary._event_time,
    test_run_summary.time,
    test_run_summary.tests,
    test_run_summary.skipped,
    test_run_summary.failures,
    test_run_summary.errors
FROM
    commons.test_run_summary
    JOIN commons.workflow_run on test_run_summary.workflow_id = CAST(workflow_run.id as string)
    JOIN commons.workflow_job on test_run_summary.job_id = workflow_job.id
WHERE
    test_run_summary._event_time >= PARSE_DATETIME_ISO8601(:startTime)
    AND test_run_summary._event_time < PARSE_DATETIME_ISO8601(:stopTime)
    AND test_run_summary.workflow_run_attempt = 1
    AND workflow_run.name = :workflowName
    AND workflow_job.name = :jobName
    AND test_run_summary.invoking_file = :testFile
    AND test_run_summary.classname = :testClass
    AND workflow_run.head_branch = 'main'
ORDER BY
    test_run_summary._event_time DESC
LIMIT
    :limit
