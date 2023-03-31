WITH average_table as (
  SELECT
    DATE_TRUNC('MONTH', DATE (CAST(date as date))) AS granularity_bucket,
    SUM(pr_count)
           AS pr_count_sum,
    ARRAY_AGG(users) as users_agg
  FROM
      metrics.external_contribution_stats
      WHERE CAST(date as date) >= PARSE_DATETIME_ISO8601(:startTime)
      AND CAST(date as date) < PARSE_DATETIME_ISO8601(:stopTime)
  GROUP BY
      DATE_TRUNC('MONTH', DATE (CAST(date as date)))
)
SELECT
-- the day will always be 01
FORMAT_ISO8601(CAST(granularity_bucket as date)) as year_and_month,
pr_count_sum as pr_count,
LENGTH(ARRAY_DISTINCT(ARRAY_FLATTEN(users_agg))) as user_count,
FROM
average_table
WHERE CAST(granularity_bucket as date) >= PARSE_DATETIME_ISO8601(:startTime)
    AND CAST(granularity_bucket as date) < PARSE_DATETIME_ISO8601(:stopTime)
ORDER BY
granularity_bucket DESC