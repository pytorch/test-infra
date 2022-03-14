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
)
select
    FORMAT_TIMESTAMP('%m-%d-%y', DATE_TRUNC('week', reviewed_on)) AS week_bucket,
    AVG(
        DATE_DIFF('minute', created_at, reviewed_on) /(60.0 * 24)
    ) as day_diff,
from
    pr_data
where
    DATE_DIFF('minute', created_at, reviewed_on) /(60.0 * 24) < 15
    and user_type = :userType
group by
    week_bucket
