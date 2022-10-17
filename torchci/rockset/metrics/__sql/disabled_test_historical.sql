WITH
disabled_tests AS (
    SELECT
        FORMAT_ISO8601(
            DATE_TRUNC(
                :granularity,
                issues._event_time AT TIME ZONE :timezone
            )
        ) AS granularity_bucket,
        COUNT(issues.title) as number_of_new_disabled_tests,
    FROM
        commons.issues
    WHERE
        issues.title LIKE '%DISABLED%'
    GROUP BY
        granularity_bucket
),
total_disabled_tests AS (
    SELECT
        granularity_bucket,
        number_of_new_disabled_tests,
        SUM(number_of_new_disabled_tests) OVER (ORDER BY granularity_bucket) AS total_number_of_disabled_tests
    FROM
        disabled_tests
)
SELECT
    *
FROM
    total_disabled_tests
WHERE
    PARSE_DATETIME_ISO8601(granularity_bucket) >= PARSE_DATETIME_ISO8601(:startTime)
    AND PARSE_DATETIME_ISO8601(granularity_bucket) < PARSE_DATETIME_ISO8601(:stopTime)
ORDER BY
    granularity_bucket DESC
