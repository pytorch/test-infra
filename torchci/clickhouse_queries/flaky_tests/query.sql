with workflows as (
    select
        id
    from
        default.workflow_run final
    where
        id in (
            select id from materialized_views.workflow_run_by_created_at
            where created_at > (CURRENT_TIMESTAMP() - interval {numHours: Int64} hour)
        )
        and head_branch like {branch: String}
        and repository.full_name = 'pytorch/pytorch'
), jobs as (
    select id
    from default.workflow_job final
    where
        run_id in (select id from workflows)
        and name not like '%rerun_disabled_tests%'
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
    any(test_run.rerun[1].'text') as sampleTraceback
FROM
    default.workflow_job job final
    INNER JOIN default.test_run_s3 test_run ON test_run.job_id = job.id
    INNER JOIN default.workflow_run workflow final ON job.run_id = workflow.id
where
    LENGTH(test_run.rerun) != 0
    AND test_run.name LIKE {name: String}
    AND test_run.classname LIKE {suite: String}
    AND test_run.file LIKE {file: String}
    and job.id in (select id from jobs)
    and workflow.id in (select id from workflows)
GROUP BY
    name,
    suite,
    file,
    invoking_file
