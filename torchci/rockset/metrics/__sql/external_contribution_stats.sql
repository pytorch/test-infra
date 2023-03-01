SELECT
    FORMAT_ISO8601(
        CAST(date as date)
    ) AS granularity_bucket,
    pr_count as pr_count,
    user_count as user_count,
FROM
    metrics.external_contribution_stats
    WHERE CAST(date as date) >= PARSE_DATETIME_ISO8601(:startTime)
    AND CAST(date as date) < PARSE_DATETIME_ISO8601(:stopTime)