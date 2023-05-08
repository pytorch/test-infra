WITH rolling_average_table as (
  SELECT
    FORMAT_ISO8601(
        CAST(date as date)
    ) AS granularity_bucket,
    -- weekly granularity with a 4 week rolling average
    TRUNC(SUM(pr_count)
           OVER(ORDER BY date ROWS 27 PRECEDING),1)/4
           AS weekly_pr_count_rolling_average,
  TRUNC(LENGTH(ARRAY_DISTINCT(ARRAY_FLATTEN(ARRAY_AGG(users)
  OVER(ORDER BY date ROWS 27 PRECEDING)))),1)/4 as weekly_user_count_rolling_average,
FROM
    metrics.external_contribution_stats
    WHERE CAST(date as date) >= PARSE_DATETIME_ISO8601(:startTime) - DAYS(28)
    AND CAST(date as date) < PARSE_DATETIME_ISO8601(:stopTime)
)
SELECT
granularity_bucket,
weekly_pr_count_rolling_average AS pr_count,
weekly_user_count_rolling_average AS user_count,
FROM
rolling_average_table
WHERE CAST(granularity_bucket as date) >= PARSE_DATETIME_ISO8601(:startTime)
    AND CAST(granularity_bucket as date) < PARSE_DATETIME_ISO8601(:stopTime)
    AND (DATE_DIFF('DAY', CAST(granularity_bucket as date), CAST(PARSE_DATETIME_ISO8601(:startTime) as date)) % 7) = 0