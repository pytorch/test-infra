--- This query returns the number of new disabled tests (number_of_new_disabled_tests)
--- and the number of open disabled tests (number_of_open_disabled_tests) daily
WITH
--- There could be day where there is no new issue or no issue is closed and we want
--- the count on that day to be 0
buckets AS (
  SELECT
    DATE_TRUNC(
      : granularity,
      CAST(issues.created_at AS TIMESTAMP) AT TIME ZONE : timezone
    ) AS granularity_bucket
  FROM
    commons.issues
  WHERE
    issues.created_at IS NOT NULL
  UNION
  SELECT
    DATE_TRUNC(
      : granularity,
      CAST(issues.closed_at AS TIMESTAMP) AT TIME ZONE : timezone
    ) AS granularity_bucket
  FROM
    commons.issues
  WHERE
    issues.closed_at IS NOT NULL
),
--- Count the newly created disabled tests
raw_new_disabled_tests AS (
  SELECT
    DATE_TRUNC(
      : granularity,
      CAST(issues.created_at AS TIMESTAMP) AT TIME ZONE : timezone
    ) AS granularity_bucket,
    COUNT(title) AS number_of_new_disabled_tests,
  FROM
    commons.issues
  WHERE
    issues.title LIKE '%DISABLED%'
  GROUP BY
    granularity_bucket
),
new_disabled_tests AS (
  SELECT
    buckets.granularity_bucket,
    COALESCE(number_of_new_disabled_tests, 0) AS number_of_new_disabled_tests,
  FROM
    buckets
    LEFT JOIN raw_new_disabled_tests ON buckets.granularity_bucket = raw_new_disabled_tests.granularity_bucket
),
aggregated_new_disabled_tests AS (
  SELECT
    granularity_bucket,
    number_of_new_disabled_tests,
    SUM(number_of_new_disabled_tests) OVER (
      ORDER BY
        granularity_bucket
    ) AS total_number_of_new_disabled_tests
  FROM
    new_disabled_tests
),
--- Count the closed disabled tests
raw_closed_disabled_tests AS (
  SELECT
    DATE_TRUNC(
      : granularity,
      CAST(issues.closed_at AS TIMESTAMP) AT TIME ZONE : timezone
    ) AS granularity_bucket,
    COUNT(title) AS number_of_closed_disabled_tests,
  FROM
    commons.issues
  WHERE
    issues.title LIKE '%DISABLED%'
    AND issues.closed_at IS NOT NULL
  GROUP BY
    granularity_bucket
),
closed_disabled_tests AS (
  SELECT
    buckets.granularity_bucket,
    COALESCE(
      number_of_closed_disabled_tests,
      0
    ) AS number_of_closed_disabled_tests,
  FROM
    buckets
    LEFT JOIN raw_closed_disabled_tests ON buckets.granularity_bucket = raw_closed_disabled_tests.granularity_bucket
),
aggregated_closed_disabled_tests AS (
  SELECT
    granularity_bucket,
    number_of_closed_disabled_tests,
    SUM(
      number_of_closed_disabled_tests
    ) OVER (
      ORDER BY
        granularity_bucket
    ) AS total_number_of_closed_disabled_tests
  FROM
    closed_disabled_tests
),
--- The final aggregated count
aggregated_disabled_tests AS (
  SELECT
    FORMAT_ISO8601(aggregated_new_disabled_tests.granularity_bucket) AS granularity_bucket,
    number_of_new_disabled_tests,
    number_of_closed_disabled_tests,
    total_number_of_new_disabled_tests,
    total_number_of_closed_disabled_tests,
    total_number_of_new_disabled_tests - total_number_of_closed_disabled_tests AS number_of_open_disabled_tests
  FROM
    aggregated_new_disabled_tests
    LEFT JOIN aggregated_closed_disabled_tests ON aggregated_new_disabled_tests.granularity_bucket = aggregated_closed_disabled_tests.granularity_bucket
)
SELECT
  *
FROM
  aggregated_disabled_tests
WHERE
  PARSE_DATETIME_ISO8601(granularity_bucket) >= PARSE_DATETIME_ISO8601(: startTime)
  AND PARSE_DATETIME_ISO8601(granularity_bucket) < PARSE_DATETIME_ISO8601(: stopTime)
ORDER BY
  granularity_bucket DESC