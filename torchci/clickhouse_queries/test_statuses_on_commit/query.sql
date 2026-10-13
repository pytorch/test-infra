WITH job AS (
    SELECT
        id,
        name
    FROM
        default.workflow_job
    WHERE
        run_id = {workflowId: String }
        AND run_attempt = {runAttempt: Int }
)

SELECT
    invoking_file,
    name,
    classname,
    multiIf(
        countIf(
            failure_count = 0
            AND error_count = 0
            AND skipped_count = 0
            AND rerun_count = 0
        ) = count(*),
        'success',
        sum(skipped_count) > 0,
        'skipped',
        countIf(
            failure_count = 0
            AND error_count = 0
        ) > 0,
        'flaky',
        'failure'
    ) AS status,
    job.name AS job_name
FROM
    tests.all_test_runs
JOIN job ON job.id = all_test_runs.job_id
WHERE
    workflow_id = {workflowId: Int64 }
    AND job_id IN (SELECT id FROM job)
    AND workflow_run_attempt = {runAttempt: Int32 }
    AND (
        match(name, {searchString: String })
        OR match(classname, {searchString: String })
        OR match(invoking_file, {searchString: String })
        OR match(job.name, {searchString: String })
    )
GROUP BY
    invoking_file,
    name,
    classname,
    job.name
ORDER BY
    status,
    job_name,
    name,
    classname,
    invoking_file
LIMIT
    {per_page: Int32 } OFFSET {offset: Int32 }
