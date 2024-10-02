select
    DATE_TRUNC(
        {granularity: String},
        rc.date
    ) as granularity_bucket,
    rc.os as platform,
    sum(rc.cost) as total_cost
from
    misc.runner_cost rc
where
    rc.date > {startTime: DateTime64(9)}
    and rc.date < {stopTime: DateTime64(9)}
    and rc.cost > 0
group by
    granularity_bucket,
    platform
order by
    granularity_bucket asc

