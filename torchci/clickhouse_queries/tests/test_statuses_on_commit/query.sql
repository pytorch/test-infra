with job as (
    select
        id,
        name
    from
        default.workflow_job
    where
        run_id = {workflowId: String }
        and run_attempt = {runAttempt: Int }
)
select
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
    job.name as job_name
from
    tests.all_test_runs
    join job on job.id = all_test_runs.job_id
where
    workflow_id = {workflowId: Int64 }
    and job_id in (select id from job)
    and workflow_run_attempt = {runAttempt: Int32 }
    and (
        match(name, {searchString: String })
        or match(classname, {searchString: String })
        or match(invoking_file, {searchString: String })
        or match(job.name, {searchString: String })
    )
group by
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
