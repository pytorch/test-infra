--- This query is used to get the LLMs benchmark results from different experiments. It
--- queries the TPS and memory bandwidth for each model / quantization combos. This powers
--- the LLMs benchmark dashboard
SELECT
  DISTINCT o.workflow_id,
  -- As the JSON response is pretty big, only return the field if it's needed
  IF(: getJobId, o.job_id, NULL) AS job_id,
  o.name,
  o.metric,
  IF(
    o.actual IS NOT NULL,
    CAST(o.actual AS FLOAT),
    0.0
  ) AS actual,
  IF(
    o.target IS NOT NULL,
    CAST(o.target AS FLOAT),
    0.0
  ) AS target,
  FORMAT_ISO8601(
    DATE_TRUNC(
      : granularity,
      TIMESTAMP_MILLIS(o.timestamp)
    )
  ) AS granularity_bucket,
  o.dtype,
  o.device,
  -- NB: Default to NVIDIA A100-SXM4-40GB for old records without arch column
  IF(
    o.arch IS NULL, 'NVIDIA A100-SXM4-40GB',
    o.arch
  ) as arch,
FROM
  benchmarks.oss_ci_benchmark_v2 o
  LEFT JOIN commons.workflow_run w ON o.workflow_id = w.id
WHERE
  TIMESTAMP_MILLIS(o.timestamp) >= PARSE_DATETIME_ISO8601(: startTime)
  AND TIMESTAMP_MILLIS(o.timestamp) < PARSE_DATETIME_ISO8601(: stopTime)
  AND (
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
  -- NB: DEVICE (ARCH) is the display format used by HUD when grouping together these two fields
  AND (
    FORMAT(
      '{} ({})',
      o.device,
      IF(
        o.arch IS NULL, 'NVIDIA A100-SXM4-40GB',
        o.arch
      )
    ) = : deviceArch
    OR : deviceArch = ''
  )
  AND (
    ARRAY_CONTAINS(
      SPLIT(: dtypes, ','),
      o.dtype
    )
    OR : dtypes = ''
  )
  AND o.metric IS NOT NULL
  AND o.dtype IS NOT NULL
  AND o.device IS NOT NULL
  AND w.html_url LIKE CONCAT('%', : repo, '%')
ORDER BY
  granularity_bucket DESC,
  workflow_id DESC,
  name,
  dtype,
  device