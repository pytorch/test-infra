-- Gets percentage of total force merges, force merges with failures, and force merges without failures (impatient)
-- Specifically this query tracks the force merges kpi and metric on HUD
--
-- Special params:
--   one_bucket: If set to false, bucketizes the results over the requested granularity
--               otherwise there is not bucketing
--   merge_type: If set, will return only data about the requested force merge type.
--               Can be one of: "All", "Impatience", "Failures", or " " (to get everything)
WITH issue_comments AS (
  SELECT
    issue_comment.user.login,
    issue_comment.author_association,
    issue_comment.body,
    issue_comment.issue_url,
    issue_comment.html_url,
    issue_comment.created,
    CAST(
      SUBSTR(
        issue_comment.issue_url,
        LENGTH(
          'https://api.github.com/repos/pytorch/pytorch/issues/'
        ) + 1
      ) AS INT
    ) AS pr_num
  FROM
    commons.issue_comment
  WHERE
    (
      issue_comment.body LIKE '%pytorchbot merge%'
      OR issue_comment.body LIKE '%pytorchmergebot merge%'
    )
    AND issue_comment.user.login NOT LIKE '%pytorch-bot%'
    AND issue_comment.user.login NOT LIKE '%facebook-github-bot%'
    AND issue_comment.user.login NOT LIKE '%pytorchmergebot%'
    AND issue_comment.issue_url LIKE '%https://api.github.com/repos/pytorch/pytorch/issues/%'
),
all_merges AS (
  SELECT
    DISTINCT m.skip_mandatory_checks,
    LENGTH(m.failed_checks) AS failed_checks_count,
    LENGTH(m.ignore_current_checks) AS ignored_checks_count,
    LENGTH(m.pending_checks) AS pending_checks_count,
    m.ignore_current,
    m.is_failed,
    m.pr_num,
    m.merge_commit_sha,
    max(c.created) AS time,
  FROM
    commons.merges m
    INNER JOIN issue_comments c ON m.pr_num = c.pr_num
  WHERE
    m.owner = 'pytorch'
    AND m.project = 'pytorch'
    AND m.merge_commit_sha != '' -- only consider successful merges
    AND m._event_time >= PARSE_DATETIME_ISO8601(: startTime)
    AND m._event_time < PARSE_DATETIME_ISO8601(: stopTime)
  GROUP BY
    m.skip_mandatory_checks,
    m.failed_checks,
    m.ignore_current,
    m.is_failed,
    m.pr_num,
    m.merge_commit_sha,
    m.ignore_current_checks,
    m.pending_checks
),
-- A legit force merge needs to satisfy one of the two conditions below:
-- 1. skip_mandatory_checks is true (-f) and failed_checks_count > 0 (with failures) or pending_checks_count > 0 (impatience).
--    Under this condition, if a force merge (-f) is done when there is no failure and all jobs have finished, it's arguably
--    just a regular merge in disguise.
-- 2. ignore_current is true (-i) and is_failed is false (indicating a successful merge) and ignored_checks_count > 0 (has failures).
--    As -i still waits for all remaining jobs to finish, this shouldn't be counted toward force merge due to impatience.
--
-- If none applies, the merge should be counted as a regular merge regardless of the use of -f or -i. We could track that
-- (regular merges masquerading as force merges) to understand how devs use (or abuse) these flags, but that's arguably a
-- different case altogether.
merges_identifying_force_merges AS (
  SELECT
    IF(
      (
        skip_mandatory_checks = true
        AND (
          failed_checks_count > 0
          OR pending_checks_count > 0
        )
      )
      OR (
        ignore_current = true
        AND is_failed = false
        AND ignored_checks_count > 0 -- if no checks were ignored, it's not a force merge
        ),
      1,
      0
    ) AS force_merge,
    failed_checks_count,
    pr_num,
    merge_commit_sha,
    ignore_current,
    ignored_checks_count,
    time,
  FROM
    all_merges
),
results AS (
  SELECT
    pr_num,
    merge_commit_sha,
    force_merge,
    IF(
      force_merge = 1
      AND (
        failed_checks_count > 0
        OR ignored_checks_count > 0
      ),
      1,
      0
    ) AS force_merge_with_failures,
    CAST(time as DATE) AS date
  FROM
    merges_identifying_force_merges
  ORDER BY
    date DESC
),
bucketed_counts AS (
  SELECT
    IF(
      : one_bucket,
      'Overall',
      FORMAT_TIMESTAMP(
        '%Y-%m-%d',
        DATE_TRUNC(: granularity, date)
      )
    ) AS granularity_bucket,
    SUM(force_merge_with_failures) AS with_failures_cnt,
    SUM(force_merge) - SUM(force_merge_with_failures) AS impatience_cnt,
    COUNT(*) AS total,
    SUM(force_merge) AS total_force_merge_cnt
  FROM
    results
  GROUP BY
    granularity_bucket
),
rolling_raw_stats AS (
  -- Average over the past buckets
  SELECT
    granularity_bucket,
    SUM(with_failures_cnt) OVER(
      ORDER BY
        granularity_bucket ROWS 1 PRECEDING
    ) AS with_failures_cnt,
    SUM(impatience_cnt) OVER(
      ORDER BY
        granularity_bucket ROWS 1 PRECEDING
    ) AS impatience_cnt,
    SUM(total_force_merge_cnt) OVER(
      ORDER BY
        granularity_bucket ROWS 1 PRECEDING
    ) AS total_force_merge_cnt,
    SUM(total) OVER(
      ORDER BY
        granularity_bucket ROWS 1 PRECEDING
    ) AS total,
  FROM
    bucketed_counts
),
stats_per_bucket AS (
  SELECT
    granularity_bucket,
    with_failures_cnt * 100.0 / total AS with_failures_percent,
    impatience_cnt * 100.0 / total AS impatience_percent,
    total_force_merge_cnt * 100.0 / total AS force_merge_percent,
  FROM
    rolling_raw_stats
),
final_table AS (
  (
    SELECT
      granularity_bucket,
      with_failures_percent AS metric,
      'From Failures' AS name
    FROM
      stats_per_bucket
  )
  UNION ALL
    (
      SELECT
        granularity_bucket,
        impatience_percent AS metric,
        'From Impatience' AS name
      FROM
        stats_per_bucket
    )
  UNION ALL
    (
      SELECT
        granularity_bucket,
        force_merge_percent AS metric,
        'All Force Merges' AS name
      FROM
        stats_per_bucket
    )
),
filtered_result AS (
  SELECT
    *
  FROM
    final_table
  WHERE
    TRIM(: merge_type) = ''
    OR name LIKE CONCAT('%', : merge_type, '%')
)
SELECT
  *
FROM
  filtered_result
ORDER BY
  granularity_bucket DESC,
  name