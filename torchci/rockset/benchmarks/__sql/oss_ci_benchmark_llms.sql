--- This query is used to get the LLMs benchmark results from different experiments. It
--- queries the TPS and memory bandwidth for each model / quantization combos. This powers
--- the LLMs benchmark dashboard
SELECT
  DISTINCT o.workflow_id,
  -- As the JSON response is pretty big, only return the field if it's needed
  IF(:getJobId, o.job_id, NULL) AS job_id,
  o.name,
  o.metric,
  IF(
    o.actual IS NOT NULL,
    CAST(o.actual AS FLOAT), 0.0
  ) AS actual,
  IF(
    o.target IS NOT NULL,
    CAST(o.target AS FLOAT), 0.0
  ) AS target,
  FORMAT_ISO8601(
    DATE_TRUNC(: granularity, w._event_time)
  ) AS granularity_bucket,
  o.dtype,
  o.device,
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
  AND (
    ARRAY_CONTAINS(
      SPLIT(: devices, ','),
      o.device
    )
    OR : devices = ''
  )
  AND (
    ARRAY_CONTAINS(
      SPLIT(: dtypes, ','),
      o.dtype
    )
    OR : dtypes = ''
  )
  AND o.metric IS NOT NULL
  AND w.html_url LIKE CONCAT('%', : repo, '%')
ORDER BY
  granularity_bucket DESC,
  workflow_id DESC,
  name ASC