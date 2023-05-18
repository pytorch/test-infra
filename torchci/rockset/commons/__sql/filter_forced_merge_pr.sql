WITH all_merges AS (
  SELECT
    skip_mandatory_checks,
    LENGTH(failed_checks) AS failed_checks_count,
    ignore_current,
    is_failed,
    pr_num,
    merge_commit_sha,
  FROM
    commons.merges
  WHERE
    owner = : owner
    AND project = : project
    AND ARRAY_CONTAINS(
      SPLIT(: shas, ','),
      merge_commit_sha
    )
),
force_merges_with_failed_checks AS (
  SELECT
    IF(
      (skip_mandatory_checks = true)
      OR (
        ignore_current = true
        AND is_failed = false
      ),
      1,
      0
    ) AS force_merge,
    pr_num,
    merge_commit_sha,
  FROM
    all_merges
)
SELECT
  *
FROM
  force_merges_with_failed_checks
WHERE
  force_merge = 1