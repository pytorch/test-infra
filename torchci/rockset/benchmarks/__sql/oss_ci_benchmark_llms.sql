--- This query is used to get the LLMs benchmark results from different experiments. It
--- queries the TPS and memory bandwidth for each model / quantization combos. This powers
--- the LLMs benchmark dashboard
SELECT
  DISTINCT o.workflow_id,
  o.name,
  o.mode AS quantization,
  IF(
    o."token_per_sec[target]" IS NOT NULL,
    o."token_per_sec[target]", 0.0
  ) AS "token_per_sec[target]",
  IF(
    o."token_per_sec[actual]" IS NOT NULL,
    o."token_per_sec[actual]", 0.0
  ) AS "token_per_sec[actual]",
  IF(
    o."memory_bandwidth[target]" IS NOT NULL,
    o."memory_bandwidth[target]", 0.0
  ) AS "memory_bandwidth[target]",
  IF(
    o."memory_bandwidth[actual]" IS NOT NULL,
    o."memory_bandwidth[actual]", 0.0
  ) AS "memory_bandwidth[actual]",
  FORMAT_ISO8601(
    DATE_TRUNC(: granularity, w._event_time)
  ) AS granularity_bucket,
FROM
  benchmarks.oss_ci_benchmark o
  LEFT JOIN commons.workflow_run w ON o.workflow_id = w.id
WHERE
  (
    ARRAY_CONTAINS(
      SPLIT(: branches, ','),
      w.head_branch
    )
    OR : branches = ''
  )
  AND (
    ARRAY_CONTAINS(
      SPLIT(: commits, ','),
      w.head_sha
    )
    OR : commits = ''
  )
  AND (
    ARRAY_CONTAINS(
      SPLIT(: filenames, ','),
      o.filename
    )
    OR : filenames = ''
  )
  AND (
    ARRAY_CONTAINS(
      SPLIT(: names, ','),
      o.name
    )
    OR : names = ''
  )
  AND o.mode = : quantization
ORDER BY
  granularity_bucket DESC,
  workflow_id DESC,
  name ASC