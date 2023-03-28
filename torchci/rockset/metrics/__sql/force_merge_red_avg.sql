WITH all_merges AS (
  SELECT
    skip_mandatory_checks,
    LENGTH(failed_checks) AS failed_checks_count,
  FROM
    commons.merges
  WHERE
    _event_time >= PARSE_DATETIME_ISO8601(:startTime)
    AND _event_time < PARSE_DATETIME_ISO8601(:stopTime)
    AND owner = :owner
    AND project = :project
),
force_merges_with_failed_checks AS (
  SELECT
    IF(skip_mandatory_checks = true AND failed_checks_count > 0, 1, 0) AS force_merges_red,
  FROM
    all_merges
)
SELECT
  AVG(force_merges_red) AS force_merges_red
FROM
  force_merges_with_failed_checks
