-- join data from pull_request_review and pull_request.
-- We are missing data from before March
with pr_data as (
    select
        min(
            PARSE_TIMESTAMP_ISO8601(pr_review.review.submitted_at)
        ) as reviewed_on,
        MIN(PARSE_TIMESTAMP_ISO8601(pr.created_at)) as created_at,
        pr.number as pr_number,
        case
            when pr.author_association = 'FIRST_TIME_CONTRIBUTOR'
            OR pr.author_association = 'CONTRIBUTOR'
            OR pr.author_association = 'NONE' THEN 'external_user'
            ELSE 'metamate'
        END as user_type,
    from
        commons.pull_request_review pr_review
        inner join commons.pull_request pr on pr_review.pull_request.number = pr.number
    where
        pr_review.action = 'submitted'
        and PARSE_TIMESTAMP_ISO8601(pr_review.review.submitted_at) > PARSE_TIMESTAMP_ISO8601(:startTime)
    group by
        pr_number,
        user_type
),
date_diffs as(
    select
        created_at,
        DATE_DIFF('hour', created_at, reviewed_on) /(24.0) as day_diff,
    from
        pr_data
    where
        user_type = :userType
)
select
    date_trunc('week', created_at) week_bucket,
    sum(
        case
            when day_diff < 2 then 1
            else 0
        end
    ) * 100.0 / count(*) as metric
from
    date_diffs
group by
    week_bucket
order by
    week_bucket
