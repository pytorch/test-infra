with jobs as (
    select
        j.created_at as created_at,
        j.id::UInt64 as id
    from
        default.workflow_job j
    where
        j.created_at >= {startTime: DateTime64(3) }
        and j.created_at < {stopTime: DateTime64(3) }
        and j.conclusion = 'success'
        and j.name = {jobName: String }
)

select
    toStartOfInterval(j.created_at, interval 6 hour) as bucket,
    round(avg(b.metric.'benchmark_values'[1]), 2) as build_time,
    -- Some stuff to make the casting work even though it shouldn't be necessary
    avgMap(mapApply(
        (k, v) -> (k, accurateCastOrDefault(v, 'UInt64')),
        b.metric. 'extra_info'
    )) as avgStats,
    minMap(mapApply(
        (k, v) -> (k, accurateCastOrDefault(v, 'UInt64')),
        b.metric. 'extra_info'
    )) as minStats,
    maxMap(mapApply(
        (k, v) -> (k, accurateCastOrDefault(v, 'UInt64')),
        b.metric. 'extra_info'
    )) as maxStats,
    quantileMap(mapApply(
        (k, v) -> (k, accurateCastOrDefault(v, 'UInt64')),
        b.metric. 'extra_info'
    )) as medStats
from
    benchmark.oss_ci_benchmark_v3 b
join jobs as j on j.id = b.job_id
where
    b.benchmark.'name' = 'sccache_stats'
    and b.job_id in (select id from jobs)
group by
    bucket
having
    count(*) > 10
