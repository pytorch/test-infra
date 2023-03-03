SELECT
    FORMAT_ISO8601(
        CAST(date as date)
    ) AS granularity_bucket,
    pr_count as pr_count,
    user_count as user_count,
    TRUNC(AVG(pr_count)
           OVER(ORDER BY date ROWS BETWEEN 6 PRECEDING AND CURRENT ROW),2)
           AS weekly_moving_average_pr_count,
    TRUNC(AVG(user_count)
           OVER(ORDER BY date ROWS BETWEEN 6 PRECEDING AND CURRENT ROW),2)
           AS weekly_moving_average_user_count,
FROM
    metrics.external_contribution_stats
    WHERE CAST(date as date) >= PARSE_DATETIME_ISO8601(:startTime)
    AND CAST(date as date) < PARSE_DATETIME_ISO8601(:stopTime)