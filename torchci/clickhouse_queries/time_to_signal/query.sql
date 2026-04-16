with
    tts as (
        SELECT
            MAX(
                DATE_DIFF(
                    'second',
                    w.created_at,
                    w.updated_at
                )
            ) as duration_sec,
            w.head_sha,
            any(IF(w.head_branch = 'main', 'main', 'not main')) as branch,
            MIN(w.created_at) as created_at
        FROM
            default.workflow_run w final
        WHERE
            lower(w.name) in ['pull', 'trunk']
            AND w.created_at >= {startTime: DateTime64(3)}
            AND w.head_repository.full_name = 'pytorch/pytorch'
            and w.id in (select id from materialized_views.workflow_run_by_created_at where created_at >= {startTime: DateTime64})
        group by
            w.head_sha
        having
            min(
                w.conclusion = 'success'
                and w.run_attempt = 1
            ) = 1
    )
select
    toStartOfWeek(t.created_at, 0) AS week_bucket,
    avg(t.duration_sec / 3600.0) as avg_tts,
    t.branch
from
    tts t
group by
    week_bucket,
    t.branch
order by
    week_bucket desc,
    t.branch desc
