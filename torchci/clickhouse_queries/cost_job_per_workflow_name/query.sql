select
    DATE_TRUNC(
        {granularity: String},
        rc.date
    ) as granularity_bucket,
    -- take first 30 characters of workflow_name
    substring(rc.workflow_name, 1, 30) as workflow_name,
    sum(rc.cost) as total_cost
from
    misc.runner_cost rc
where
    rc.date > {startTime: DateTime64(9)}
    and rc.date < {stopTime: DateTime64(9)}
    and rc.cost > 0
group by
    granularity_bucket,
    workflow_name
order by
    granularity_bucket asc

