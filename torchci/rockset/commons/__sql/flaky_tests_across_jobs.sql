with failed_jobs as (
    SELECT
        FIRST_VALUE(job.conclusion) OVER(
            PARTITION BY CONCAT(w.name, ' / ', job.name)
            ORDER BY
                push.head_commit.timestamp ROWS BETWEEN 1 PRECEDING
                AND 1 FOLLOWING
        ) = 'success'
        and NTH_VALUE(job.conclusion, 2) OVER(
            PARTITION BY CONCAT(w.name, ' / ', job.name)
            ORDER BY
                push.head_commit.timestamp ROWS BETWEEN 1 PRECEDING
                AND 1 FOLLOWING
        ) = 'failure'
        and LAST_VALUE(job.conclusion) OVER(
            PARTITION BY CONCAT(w.name, ' / ', job.name)
            ORDER BY
                push.head_commit.timestamp ROWS BETWEEN 1 PRECEDING
                AND 1 FOLLOWING
        ) = 'success' as flaky,
        job.id,
        job.head_sha,
        job.name as jobname,
        w.id as workflow_id,
        w.head_branch,
        w.name as workflow_name,
        w.run_attempt as workflow_run_attempt,
    from
        commons.workflow_job job
        join commons.workflow_run w on w.id = job.run_id
        and w.head_repository.full_name = 'pytorch/pytorch'
        join push on push.head_commit.id = w.head_commit.id
    where
        job._event_time >= CURRENT_DATE() - HOURS(:numHours)
        and w.head_branch = 'main'
        and w.name in ('trunk', 'pull')
        and job.name not like '%mem_leak_check%'
        and job.name not like '%rerun_disabled_tests%'
    order by
        job._event_time
),
flaky_jobs as (
    select
        distinct *
    from
        failed_jobs
        left join commons.job_annotation annotation on annotation.jobID = failed_jobs.id
    where
        (
            failed_jobs.flaky
            and annotation.annotation is NULL
        )
        or annotation.annotation = 'TEST_FLAKE'
),
flaky_tests as (
    select
        test_run.name,
        test_run.file,
        test_run.classname,
        test_run.invoking_file,
        *,
        if (
            test_run.failure is null,
            test_run.error.message,
            test_run.failure.message
        ) as failure_or_err_message,
        test_run._event_time as event_time
    from
        test_run_s3 test_run
        join flaky_jobs job on test_run.job_id = job.id
        and test_run.workflow_run_attempt = job.workflow_run_attempt
    where
        (
            test_run.error is not null
            or test_run.failure is not null
        )
        and test_run.file is not null
    order by
        test_run.name
)
select
    name,
    classname as suite,
    file,
    invoking_file,
    ARRAY_AGG(jobname) as jobNames,
    ARRAY_AGG(id) as jobIds,
    ARRAY_AGG(workflow_id) as workflowIds,
    ARRAY_AGG(workflow_name) as workflowNames,
    ARRAY_AGG(workflow_run_attempt) as runAttempts,
    ARRAY_AGG(event_time) as eventTimes,
    ARRAY_AGG(head_branch) as branches
from
    flaky_tests
where
    not REGEXP_LIKE(failure_or_err_message, :ignoreMessages)
group by
    name,
    file,
    classname,
    invoking_file
order by
    name
