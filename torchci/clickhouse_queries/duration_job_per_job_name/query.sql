select
    DATE_TRUNC(
        {granularity: String},
        rc.date
    ) as granularity_bucket,
    -- take first 20 characters of job_name
    substring(rc.job_name, 1, 20) as job_name,
    sum(rc.duration) as total_duration
from
    misc.runner_cost rc
where
    rc.date > {startTime: DateTime64(9)}
    and rc.date < {stopTime: DateTime64(9)}
    and rc.duration > 0
group by
    granularity_bucket,
    job_name
order by
    granularity_bucket asc

