WITH job AS (
    SELECT DISTINCT
        id,
        name
    FROM
        default.workflow_job
    WHERE
        run_id = {workflowId: Int64 }
        AND run_attempt = {runAttempt: Int32 }
        AND name = {jobName: String }
)

SELECT
    invoking_file,
    name,
    classname,
    skipped,
    rerun,
    failure,
    error,
    job_id
FROM
    tests.all_test_runs
JOIN job ON job.id = all_test_runs.job_id
WHERE
    job_id IN (SELECT id FROM job)
    AND workflow_id = {workflowId: Int64 }
    AND workflow_run_attempt = {runAttempt: Int32 }
    AND (
        all_test_runs.name = {testName: String }
        AND classname = {className: String }
        AND invoking_file = {invokingFile: String }
    )
