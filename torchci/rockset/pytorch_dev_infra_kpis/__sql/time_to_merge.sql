with parsed_time as (
    SELECT
        PARSE_DATETIME_ISO8601(merged_at) as merged_time,
        PARSE_DATETIME_ISO8601(created_at) as created_time,
        PARSE_DATETIME_ISO8601(closed_at) as closed_time,
        case
            when author_association = 'FIRST_TIME_CONTRIBUTOR'
            OR author_association = 'CONTRIBUTOR'
            OR author_association = 'NONE' THEN 'external_user'
            ELSE 'metamate'
        END as user_type,
        number,
    FROM
        commons.pull_request
    where
        (
            closed_at is not null
            or merged_at is not null
        )
        and pull_request.closed_at > :startTime
)
select
    FORMAT_TIMESTAMP('%m-%d-%y', DATE_TRUNC('week', closed_time)) AS week_bucket,
    CASE
        when :mergeOrClose = 'merge' THEN AVG(DATE_DIFF('day', created_time, merged_time))
        ELSE AVG(DATE_DIFF('day', created_time, closed_time))
    END as metric
from
    parsed_time
where
    DATE_DIFF('day', created_time, closed_time) < 15
    and user_type = :userType
group by
    week_bucket
order by
    week_bucket
