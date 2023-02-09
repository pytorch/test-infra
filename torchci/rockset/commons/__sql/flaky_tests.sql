    SELECT
    test_run.name,
    test_run.classname as suite,
    test_run.file,
    test_run.invoking_file,
    SUM(
        ELEMENT_AT(
            JSON_PARSE(
                REPLACE(test_run.skipped.message, 'True', 'true')
            ),
            'num_green'
        )
    ) as numGreen,
    SUM(
        ELEMENT_AT(
            JSON_PARSE(
                REPLACE(test_run.skipped.message, 'True', 'true')
            ),
            'num_red'
        )
    ) as numRed,
    ARRAY_AGG(job.name) as jobNames,
    ARRAY_AGG(job.id) as jobIds,
    ARRAY_AGG(workflow.id) as workflowIds,
    ARRAY_AGG(workflow.name) as workflowNames,
    ARRAY_AGG(workflow.head_branch) as branches,
    ARRAY_AGG(test_run.workflow_run_attempt) as runAttempts
FROM
    commons.workflow_job job
    INNER JOIN commons.test_run_s3 test_run ON test_run.job_id = job.id HINT(join_strategy = lookup)
    INNER JOIN commons.workflow_run workflow ON job.run_id = workflow.id
WHERE
    test_run.skipped.message LIKE '{%"flaky": _rue%'
    AND test_run._event_time > (CURRENT_TIMESTAMP() - HOURs(:numHours))
    AND test_run.name LIKE :name
    AND test_run.classname LIKE :suite
    AND test_run.file LIKE :file
    AND job.name NOT LIKE '%rerun_disabled_tests%'
GROUP BY
    name,
    suite,
    file,
    invoking_file
UNION
select
    test_run.name,
    test_run.classname as suite,
    test_run.file,
    test_run.invoking_file,
    COUNT(*) as numGreen,
    SUM(
        if(
            TYPEOF(test_run.rerun) = 'object',
            1,
            Length(test_run.rerun)
        )
    ) as numRed,
    ARRAY_AGG(job.name) as jobNames,
    ARRAY_AGG(job.id) as jobIds,
    ARRAY_AGG(workflow.id) as workflowIds,
    ARRAY_AGG(workflow.name) as workflowNames,
    ARRAY_AGG(workflow.head_branch) as branches,
    ARRAY_AGG(test_run.workflow_run_attempt) as runAttempts
FROM
    commons.workflow_job job
    INNER JOIN commons.test_run_s3 test_run ON test_run.job_id = job.id HINT(join_strategy = lookup)
    INNER JOIN commons.workflow_run workflow ON job.run_id = workflow.id
where
    test_run.rerun is not null
    and test_run.failure is null
    AND test_run._event_time > (CURRENT_TIMESTAMP() - HOURs(:numHours))
    AND test_run.name LIKE :name
    AND test_run.classname LIKE :suite
    AND test_run.file LIKE :file
    AND job.name NOT LIKE '%rerun_disabled_tests%'
GROUP BY
    name,
    suite,
    file,
    invoking_file
