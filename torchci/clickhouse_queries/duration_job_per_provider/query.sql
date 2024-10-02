select
    DATE_TRUNC(
        {granularity: String},
        rc.date
    ) as granularity_bucket,
    rc.provider,
    sum(rc.duration) as total_duration
from
    misc.runner_cost rc
where
    rc.date > {startTime: DateTime64(9)}
    and rc.date < {stopTime: DateTime64(9)}
    and rc.duration > 0
group by
    granularity_bucket,
    rc.provider
order by
    granularity_bucket asc

