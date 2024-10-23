-- This query returns the number of new disabled tests (number_of_new_disabled_tests)
-- and the number of open disabled tests (number_of_open_disabled_tests) daily
WITH issues_with_labels AS (
    SELECT
        i.title,
        i.body,
        groupArrayArray(i.labels. 'name') AS labels,
        parseDateTimeBestEffortOrNull(i.created_at) AS created_at,
        parseDateTimeBestEffortOrNull(i.closed_at) AS closed_at
    FROM
        default .issues i FINAL
    WHERE
        i.repository_url = CONCAT('https://api.github.com/repos/', {repo: String })
        AND i.title LIKE '%DISABLED%'
        AND (
            {platform: String } = ''
            OR i.body LIKE CONCAT('%', {platform: String }, '%')
            OR (NOT i.body LIKE '%Platforms: %')
        )
    GROUP BY
        i.title,
        i.body,
        i.created_at,
        i.closed_at
),
-- There could be day where there is no new issue or no issue is closed and we want
-- the count on that day to be 0
buckets AS (
    SELECT
        DATE_TRUNC(
            {granularity: String },
            parseDateTimeBestEffortOrNull(i.created_at)
        ) AS granularity_bucket
    FROM
        default .issues i FINAL
    WHERE
        i.created_at != ''
    UNION
        DISTINCT
    SELECT
        DATE_TRUNC(
            {granularity: String },
            parseDateTimeBestEffortOrNull(i.closed_at)
        ) AS granularity_bucket
    FROM
        default .issues i FINAL
    WHERE
        i.closed_at != ''
),
-- Count the newly created disabled tests
raw_new_disabled_tests AS (
    SELECT
        DATE_TRUNC({granularity: String }, i.created_at) AS granularity_bucket,
        COUNT(i.title) AS number_of_new_disabled_tests
    FROM
        issues_with_labels i
    WHERE
        has(i.labels, 'skipped')
        AND (
            {label: String } = ''
            OR has(i.labels, {label: String })
        )
        AND (
            {triaged: String } = ''
            OR (
                {triaged: String } = 'yes'
                AND has(i.labels, 'triaged')
            )
            OR (
                {triaged: String } = 'no'
                AND NOT has(i.labels, 'triaged')
            )
        )
    GROUP BY
        granularity_bucket
),
new_disabled_tests AS (
    SELECT
        buckets.granularity_bucket,
        COALESCE(number_of_new_disabled_tests, 0) AS number_of_new_disabled_tests
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
-- Count the closed disabled tests
raw_closed_disabled_tests AS (
    SELECT
        DATE_TRUNC({granularity: String }, i.closed_at) AS granularity_bucket,
        COUNT(i.title) AS number_of_closed_disabled_tests
    FROM
        issues_with_labels i
    WHERE
        i.closed_at IS NOT NULL
        AND has(i.labels, 'skipped')
        AND (
            {label: String } = ''
            OR has(i.labels, {label: String })
        )
        AND (
            {triaged: String } = ''
            OR (
                {triaged: String } = 'yes'
                AND has(i.labels, 'triaged')
            )
            OR (
                {triaged: String } = 'no'
                AND NOT has(i.labels, 'triaged')
            )
        )
    GROUP BY
        granularity_bucket
),
closed_disabled_tests AS (
    SELECT
        buckets.granularity_bucket,
        COALESCE(number_of_closed_disabled_tests, 0) AS number_of_closed_disabled_tests
    FROM
        buckets
        LEFT JOIN raw_closed_disabled_tests ON buckets.granularity_bucket = raw_closed_disabled_tests.granularity_bucket
),
aggregated_closed_disabled_tests AS (
    SELECT
        granularity_bucket,
        number_of_closed_disabled_tests,
        SUM(number_of_closed_disabled_tests) OVER (
            ORDER BY
                granularity_bucket
        ) AS total_number_of_closed_disabled_tests
    FROM
        closed_disabled_tests
),
-- The final aggregated count
aggregated_disabled_tests AS (
    SELECT
        aggregated_new_disabled_tests.granularity_bucket AS granularity_bucket,
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
    granularity_bucket >= {startTime: DateTime64(3) }
    AND granularity_bucket < {stopTime: DateTime64(3) }
ORDER BY
    granularity_bucket DESC
