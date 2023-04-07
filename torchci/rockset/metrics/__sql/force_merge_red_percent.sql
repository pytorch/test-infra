WITH all_merges AS (
  SELECT
    _event_time as time,
    skip_mandatory_checks,
    LENGTH(failed_checks) AS failed_checks_count,
    ignore_current,
    is_failed,
  FROM
    commons.merges
  WHERE
    _event_time >= PARSE_DATETIME_ISO8601(: startTime)
    AND _event_time < PARSE_DATETIME_ISO8601(: stopTime)
    AND owner = : owner
    AND project = : project
),
force_merges_with_failed_checks AS (
  SELECT
    time,
    IF(
      (
        skip_mandatory_checks = true
        AND failed_checks_count > 0
      )
      OR (
        ignore_current = true
        AND is_failed = false
      ),
      1,
      0
    ) AS force_merges_red,
  FROM
    all_merges
)
SELECT
  FORMAT_TIMESTAMP(
    '%Y-%m-%d',
    DATE_TRUNC(: granularity, time)
  ) AS granularity_bucket,
  AVG(force_merges_red) AS force_merges_red
FROM
  force_merges_with_failed_checks
GROUP BY
  granularity_bucket
ORDER BY
  granularity_bucket ASC