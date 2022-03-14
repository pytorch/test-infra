with completed_workflows as (
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
),
tts_by_sha as (
    select
        c.head_sha,
        PARSE_TIMESTAMP_ISO8601(c.created_at) as created_at,
        max(PARSE_TIMESTAMP_ISO8601(job.completed_at)) as completed_at
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
        DATE_DIFF('second', created_at, completed_at) / 60.0
    ) as avg_tts,
from
    tts_by_sha
group by
    week_bucket
order by
    week_bucket asc
