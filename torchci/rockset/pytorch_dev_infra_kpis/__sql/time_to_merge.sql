with parsed_time as (
    SELECT
        PARSE_DATETIME_ISO8601(created_at) as created_time,
        PARSE_DATETIME_ISO8601(closed_at) closed_time,case
            when author_association = 'FIRST_TIME_CONTRIBUTOR'
            OR author_association = 'CONTRIBUTOR'
            OR author_association = 'NONE' THEN 'external_user'
            ELSE 'metamate'
        END as user_type,
        number,
    FROM
        commons.pull_request
    where
        PARSE_DATETIME_ISO8601(created_at) > PARSE_DATETIME_ISO8601(:startTime)
),
time_diffs as (
    select
        created_time,
        DATE_DIFF('day', created_time, closed_time) d_diff,
    from
        parsed_time
    where
        user_type = :userType
)
select
    DATE_TRUNC('WEEK', created_time) AS week_bucket,
    sum(
        case
            when d_diff < :closeSLO then 1
            else 0
        end
    ) * 100.0 / count(*) metric
from
    time_diffs
group by
    week_bucket
ORDER BY
    week_bucket
