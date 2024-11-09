WITH average_table as (
    SELECT
        DATE_TRUNC('MONTH', date) AS granularity_bucket,
        SUM(pr_count) AS pr_count_sum,
        ARRAY_AGG(users) as users_agg
    FROM
        misc.external_contribution_stats
    WHERE
        date >= {startTime: DateTime64(9) }
        AND date < {stopTime: DateTime64(9) }
    GROUP BY
        granularity_bucket
)
SELECT
    -- the day will always be 01
    granularity_bucket as year_and_month,
    pr_count_sum as pr_count,
    LENGTH(arrayDistinct(arrayFlatten(users_agg))) as user_count
FROM
    average_table
WHERE
    granularity_bucket >= {startTime: DateTime64(9) }
    AND granularity_bucket < {stopTime: DateTime64(9) }
ORDER BY
    granularity_bucket DESC
