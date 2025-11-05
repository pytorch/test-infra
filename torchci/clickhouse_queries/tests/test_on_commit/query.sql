with job as (
    select
        id,
        name
    from
        default.workflow_job
    where
        run_id = {workflowId: Int64 }
        and run_attempt = {runAttempt: Int32 }
        and name = {jobName: String }
)
select
    invoking_file,
    name,
    classname,
    skipped,
    rerun,
    failure,
    error,
    job_id
from
    tests.all_test_runs
    join job on job.id = all_test_runs.job_id
where
    job_id in (select id from job)
    and workflow_id = {workflowId: Int64 }
    and workflow_run_attempt = {runAttempt: Int32 }
    and (
        all_test_runs.name = {testName: String }
        and classname = {className: String }
        and invoking_file = {invokingFile: String }
    )
