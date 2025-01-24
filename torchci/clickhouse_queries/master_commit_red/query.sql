--- This query is used to show the histogram of trunk red commits on HUD metrics page
--- during a period of time
-- Split up the query into multiple CTEs to make it faster.
with commits as (
    select
        push.head_commit.'timestamp' as time,
        push.head_commit.'id' as sha
    from
    -- Not using final since push table doesn't really get updated
        push
    where
        push.ref in ('refs/heads/master', 'refs/heads/main')
        and push.repository.'owner'.'name' = 'pytorch'
        and push.repository.'name' = 'pytorch'
        and push.head_commit.'timestamp' >= {startTime: DateTime64(3)}
        and push.head_commit.'timestamp' < {stopTime: DateTime64(3)}
),

all_runs as (
    select
        workflow_run.id as id,
        workflow_run.head_commit.'id' as sha,
        workflow_run.name as name,
        commit.time as time
    from
        workflow_run final
    join commits commit on workflow_run.head_commit.'id' = commit.sha
    where
        (
            -- Limit it to workflows which block viable/strict upgrades
            workflow_run.name in ('Lint', 'pull', 'trunk')
            or workflow_run.name like 'linux-binary%'
        )
        and workflow_run.event != 'workflow_run' -- Filter out workflow_run-triggered jobs, which have nothing to do with the SHA
        and workflow_run.id in (
            select id from materialized_views.workflow_run_by_head_sha
            where head_sha in (select sha from commits)
        )
),

all_jobs as (
    select
        all_runs.time as time,
        case
            when job.conclusion = 'failure' then 'red'
            when job.conclusion = 'timed_out' then 'red'
            when job.conclusion = 'cancelled' then 'red'
            when job.conclusion = '' then 'pending'
            else 'green'
        end as conclusion,
        all_runs.sha as sha
    from
        default.workflow_job job final
    join all_runs all_runs on all_runs.id = workflow_job.run_id
    where
        job.name != 'ciflow_should_run'
        and job.name != 'generate-test-matrix'
        and job.name not like '%rerun_disabled_tests%'
        and job.name not like '%unstable%'
        and job.id in (
            select id from materialized_views.workflow_job_by_head_sha
            where head_sha in (select sha from commits)
        )
),

commit_overall_conclusion as (
    select
        time,
        sha,
        case
            when countIf(conclusion = 'red') > 0 then 'red'
            when countIf(conclusion = 'pending') > 0 then 'pending'
            else 'green'
        end as overall_conclusion
    from
        all_jobs
    group by
        time,
        sha
    having
        COUNT(*) > 10 -- Filter out jobs that didn't run anything.
    order by
        time desc
)

select
    toDate(
        date_trunc('hour', time),
        {timezone: String}
    ) as granularity_bucket,
    countIf(overall_conclusion = 'red') as red,
    countIf(overall_conclusion = 'pending') as pending,
    countIf(overall_conclusion = 'green') as green,
    COUNT(*) as total
from
    commit_overall_conclusion
group by
    granularity_bucket
order by
    granularity_bucket asc
