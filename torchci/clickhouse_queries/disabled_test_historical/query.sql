-- !!! Query is not converted to CH syntax yet.  Delete this line when it gets converted
--- This query returns the number of new disabled tests (number_of_new_disabled_tests)
--- and the number of open disabled tests (number_of_open_disabled_tests) daily
WITH issues_with_labels AS (
  SELECT
    i.title,
    i.body,
    ARRAY_AGG(labels.value.name) AS labels,
    i.created_at,
    i.closed_at
  FROM
    commons.issues i,
    UNNEST (i.labels AS value) AS labels
  WHERE
    i.repository_url = CONCAT(
      'https://api.github.com/repos/',
      : repo
    )
    AND i.title LIKE '%DISABLED%'
    AND (
      : platform = ''
      OR i.body LIKE CONCAT('%', : platform, '%')
      OR (NOT i.body LIKE '%Platforms: %')
    )
  GROUP BY
    i.title,
    i.body,
    i.created_at,
    i.closed_at
),
--- There could be day where there is no new issue or no issue is closed and we want
--- the count on that day to be 0
buckets AS (
  SELECT
    DATE_TRUNC(
      : granularity,
      CAST(i.created_at AS TIMESTAMP) AT TIME ZONE : timezone
    ) AS granularity_bucket
  FROM
    commons.issues i
  WHERE
    i.created_at IS NOT NULL
  UNION
  SELECT
    DATE_TRUNC(
      : granularity,
      CAST(i.closed_at AS TIMESTAMP) AT TIME ZONE : timezone
    ) AS granularity_bucket
  FROM
    commons.issues i
  WHERE
    i.closed_at IS NOT NULL
),
--- Count the newly created disabled tests
raw_new_disabled_tests AS (
  SELECT
    DATE_TRUNC(
      : granularity,
      CAST(i.created_at AS TIMESTAMP) AT TIME ZONE : timezone
    ) AS granularity_bucket,
    COUNT(i.title) AS number_of_new_disabled_tests,
  FROM
    issues_with_labels i
  WHERE
    ARRAY_CONTAINS(i.labels, 'skipped')
    AND (
      : label = ''
      OR ARRAY_CONTAINS(i.labels, : label)
    )
    AND (
      : triaged = ''
      OR (
        : triaged = 'yes'
        AND ARRAY_CONTAINS(i.labels, 'triaged')
      )
      OR (
        : triaged = 'no'
        AND NOT ARRAY_CONTAINS(i.labels, 'triaged')
      )
    )
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
      CAST(i.closed_at AS TIMESTAMP) AT TIME ZONE : timezone
    ) AS granularity_bucket,
    COUNT(i.title) AS number_of_closed_disabled_tests,
  FROM
    issues_with_labels i
  WHERE
    i.closed_at IS NOT NULL
    AND ARRAY_CONTAINS(i.labels, 'skipped')
    AND (
      : label = ''
      OR ARRAY_CONTAINS(i.labels, : label)
    )
    AND (
      : triaged = ''
      OR (
        : triaged = 'yes'
        AND ARRAY_CONTAINS(i.labels, 'triaged')
      )
      OR (
        : triaged = 'no'
        AND NOT ARRAY_CONTAINS(i.labels, 'triaged')
      )
    )
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
    FORMAT_ISO8601(
      aggregated_new_disabled_tests.granularity_bucket
    ) AS granularity_bucket,
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