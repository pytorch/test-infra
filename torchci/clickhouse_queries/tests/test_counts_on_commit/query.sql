with job as (
    select
        id,
        name
    from
        default .workflow_job
    where
        run_id = {workflowId: String }
        and run_attempt = {runAttempt: Int }
)
select
    count(distinct invoking_file, name, classname, job.name) as count
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
