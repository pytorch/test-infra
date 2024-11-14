with viable_strict as (
    select
        sha,
        timestamp
    from
        misc.stable_pushes
    where
        timestamp >= {startTime: DateTime64(3) }
        and timestamp < {stopTime: DateTime64(3) }
        and repository = {repoFullName: String }
)
select
    distinct AVG(
        DATE_DIFF(
            'minute',
            push.head_commit.timestamp,
            viable_strict.timestamp
        ) / 60.0
    ) as diff_hr,
    DATE_TRUNC({granularity: String }, viable_strict.timestamp) AS push_time
from
    -- Not bothering with final because I don't expect push to change
    default .push
    join viable_strict on push.head_commit.id = viable_strict.sha
group by
    push_time
order by
    push_time
