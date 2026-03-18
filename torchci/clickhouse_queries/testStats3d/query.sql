with test_info as (
    select
        t.invoking_file,
        t.job_id,
        t.time,
        t.failure,
        t.error,
        t.skipped,
        t.rerun
    from
        default .test_run_s3 t
    where
        t.name = {name: String }
        and t.classname = {suite: String }
        and t.file = {file: String }
        and t.time_inserted > now() - interval 3 day
),
per_job as (
    select
        t.invoking_file,
        j.id,
        avg(t.time) as time,
        multiIf(
            sum(length(t.failure)) + sum(length(t.error)) = count(*),
            'failed',
            sum(length(t.failure)) + sum(length(t.error)) + sum(length(t.rerun)) > 0,
            'flaky',
            sum(length(t.skipped)) = count(*),
            'skipped',
            'success'
        ) as conclusion,
        j.name as job_name,
        any(j.created_at) as job_created_at
    from
        test_info t
        join default .workflow_job j on t.job_id = j.id
    where
        j.id in (
            select
                t.job_id
            from
                test_info t
        )
        and j.name like {jobFilter: String}
    group by
        j.id,
        j.name,
        t.invoking_file
)
select
    DATE_TRUNC('hour', job_created_at) as hour,
    groupArray(conclusion) as conclusions
from
    per_job
group by
    hour
