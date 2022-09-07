with failed_workflows as (
	Select
        DISTINCT(w.head_commit.id)	as sha
    from commons.workflow_run w
    where
        w.conclusion in ('failure', 'startup_failure', 'cancelled')
        AND w.repository.full_name = 'pytorch/pytorch'
),
successful_commits as (
  select 
      w.head_commit.id as sha,
      count(*) as cnt,
      MIN(w.created_at) as created_at
  from 
      commons.workflow_run w LEFT OUTER JOIN failed_workflows f on w.head_commit.id = f.sha
  where 
      f.sha is null
      and PARSE_TIMESTAMP_ISO8601(w.created_at) > PARSE_TIMESTAMP_ISO8601(:startTime)
      AND w.repository.full_name = 'pytorch/pytorch'
      and w.conclusion = 'success'
      and w.run_attempt = 1 
  group by sha
),
completed_workflows as (
    select
        w.created_at as created_at,
        w.id,
        w.head_sha
    from
        commons.workflow_run w
    where
        status = 'completed'
        AND w.repository.full_name = 'pytorch/pytorch'
        and PARSE_TIMESTAMP_ISO8601(w.created_at) > PARSE_TIMESTAMP_ISO8601(:startTime)
        and w.run_attempt = 1 
        and w.head_sha in (select sha from successful_commits)
),
tts_by_sha as (
    select
        c.head_sha,
        PARSE_TIMESTAMP_ISO8601(c.created_at) as created_at,
        max(PARSE_TIMESTAMP_ISO8601(job.completed_at)) as completed_at,
        count(*) as job_cnt
    from
        completed_workflows c HINT(access_path = column_scan)
        inner join commons.workflow_job job on c.id = job.run_id
    where
        name like case
            when :buildOrAll = 'build' then 'build'
            else '%'
        end
    group by
        head_sha,
        created_at
)
select
    CAST(DATE_TRUNC('WEEK', created_at) as string) AS week_bucket,
    avg(
        DATE_DIFF('minute', created_at, completed_at) / 60.0
    ) as avg_tts,
from
    tts_by_sha
where
    job_cnt > 35
group by
    week_bucket
order by
    week_bucket desc