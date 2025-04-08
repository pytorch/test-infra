WITH rolling_average_table AS (
    SELECT
        date AS granularity_bucket,
        -- weekly granularity with a 4 week rolling average
        TRUNC(
            SUM(pr_count) OVER (
                ORDER BY
                    date
                ROWS 27 PRECEDING
            ),
            1
        ) / 4 AS weekly_pr_count_rolling_average,
        TRUNC(
            LENGTH(
                arrayDistinct(
                    arrayFlatten(
                        ARRAY_AGG(users) OVER (
                            ORDER BY
                                date
                            ROWS 27 PRECEDING
                        )
                    )
                )
            ),
            1
        ) / 4 AS weekly_user_count_rolling_average
    FROM
        misc.external_contribution_stats
    WHERE
        date >= {startTime: DateTime64(9) } - INTERVAL 28 DAY
        AND date < {stopTime: DateTime64(9) }
)

SELECT
    granularity_bucket,
    weekly_pr_count_rolling_average AS pr_count,
    weekly_user_count_rolling_average AS user_count
FROM
    rolling_average_table
WHERE
    granularity_bucket >= {startTime: DateTime64(9) }
    AND granularity_bucket < {stopTime: DateTime64(9) }
    AND (
        DATE_DIFF(
            'DAY',
            granularity_bucket,
            {startTime: DateTime64(9) }
        ) % 7
    ) = 0
