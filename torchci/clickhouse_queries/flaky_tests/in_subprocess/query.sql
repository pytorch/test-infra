with flaky_tests as (
    select
        *
    from
        default .test_run_s3 test_run
    where
        LENGTH(test_run.rerun) != 0
        AND LENGTH(test_run.failure) = 0
        AND test_run.name LIKE {name: String }
        AND test_run.classname LIKE {suite: String }
        AND test_run.file LIKE {file: String }
        and test_run.time_inserted > (CURRENT_TIMESTAMP() - interval {numHours: Int64} hour)
)
select
    test_run.name as name,
    test_run.classname as suite,
    test_run.file as file,
    test_run.invoking_file as invoking_file,
    COUNT(*) as numGreen,
    SUM(Length(test_run.rerun)) as numRed,
    ARRAY_AGG(job.name) as jobNames,
    ARRAY_AGG(job.id) as jobIds,
    ARRAY_AGG(workflow.id) as workflowIds,
    ARRAY_AGG(workflow.name) as workflowNames,
    ARRAY_AGG(workflow.head_branch) as branches,
    ARRAY_AGG(test_run.workflow_run_attempt) as runAttempts,
    any(test_run.rerun [ 1 ].'text') as sampleTraceback
FROM
    default .workflow_job job final
    INNER JOIN flaky_tests test_run ON test_run.job_id = job.id
    INNER JOIN default .workflow_run workflow final ON job.run_id = workflow.id
where
    workflow.id in (
        select
            workflow_id
        from
            flaky_tests
    )
    and job.id in (
        select
            job_id
        from
            flaky_tests
    )
    and workflow.head_branch = 'main'
    and workflow.repository. 'full_name' = 'pytorch/pytorch'
    and job.name not like '%rerun_disabled_tests%'
GROUP BY
    name,
    suite,
    file,
    invoking_file
