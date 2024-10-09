select
    distinct(rc.group_repo) as repo
    -- count(rc.group_repo) as count
from
    misc.runner_cost rc
where
    rc.date > {startTime: DateTime64(9)}
    and rc.date < {stopTime: DateTime64(9)}
group by
    repo
order by
    count(rc.group_repo) desc
