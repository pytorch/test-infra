WITH performance_results AS (
  SELECT
  name,
  IF(speedup = 'infra_error', NULL, speedup) AS speedup, -- Handle the recent burst of infra error
  REPLACE(
    filename,
    CONCAT(
      '_', : dtypes, '_', : mode, '_', : device,
      '_performance'
    )
  ) AS filename,
  compilation_latency,
  compression_ratio,
  abs_latency,
  mfu,
  memory_bandwidth,
  dynamo_peak_mem,
  eager_peak_mem,
  workflow_id,
  CAST(job_id AS INT) AS job_id,
  FORMAT_ISO8601(
    DATE_TRUNC(: granularity, _event_time)
  ) AS granularity_bucket,
  head_sha,
  head_branch,
FROM
  inductor.torchao_perf_stats
WHERE
  filename LIKE '%_performance'
  AND filename LIKE CONCAT(
    '%_', : dtypes, '_', : mode, '_', : device,
    '_%'
  )
  AND _event_time >= PARSE_DATETIME_ISO8601(:startTime)
  AND _event_time < PARSE_DATETIME_ISO8601(:stopTime)
  AND (workflow_id = :workflowId OR :workflowId = 0)
),
accuracy_results AS (
  SELECT
    name,
    accuracy,
    REPLACE(
      filename,
      CONCAT(
        '_', : dtypes, '_', : mode, '_', : device,
        '_accuracy'
      )
    ) AS filename,
    workflow_id,
    CAST(job_id AS INT) AS job_id,
  FROM
    inductor.torchao_perf_stats
  WHERE
    filename LIKE '%_accuracy'
    AND filename LIKE CONCAT(
      '%_', : dtypes, '_', : mode, '_', : device,
      '_%'
    )
    AND _event_time >= PARSE_DATETIME_ISO8601(:startTime)
    AND _event_time < PARSE_DATETIME_ISO8601(:stopTime)
    AND (workflow_id = :workflowId OR :workflowId = 0)
    AND accuracy != 'model_fail_to_load'
    AND accuracy != 'eager_fail_to_run'
),
results AS (
  SELECT
    performance_results.granularity_bucket AS granularity_bucket,
    performance_results.workflow_id AS workflow_id,
    performance_results.job_id AS job_id,
    performance_results.head_branch AS head_branch,
    performance_results.head_sha AS head_sha,
    CASE
      WHEN performance_results.filename LIKE '%_torchbench' THEN 'torchbench'
      WHEN performance_results.filename LIKE '%_timm_models' THEN 'timm_models'
      WHEN performance_results.filename LIKE '%_huggingface' THEN 'huggingface'
      ELSE NULL
    END AS suite,
    CASE
      WHEN performance_results.filename LIKE '%_torchbench' THEN REPLACE(
        performance_results.filename, '_torchbench'
      )
      WHEN performance_results.filename LIKE '%_timm_models' THEN REPLACE(
        performance_results.filename, '_timm_models'
      )
      WHEN performance_results.filename LIKE '%_huggingface' THEN REPLACE(
        performance_results.filename, '_huggingface'
      )
      ELSE NULL
    END AS compiler,
    performance_results.name,
    IF(TRY_CAST(speedup AS FLOAT) IS NOT NULL,
      CAST(speedup AS FLOAT),
      0.0
    ) AS speedup,
    accuracy_results.accuracy AS accuracy,
    IF(TRY_CAST(compilation_latency AS FLOAT) IS NOT NULL,
      CAST(compilation_latency AS FLOAT),
      0.0
    ) AS compilation_latency,
    IF(TRY_CAST(compression_ratio AS FLOAT) IS NOT NULL,
      CAST(compression_ratio AS FLOAT),
      0.0
    ) AS compression_ratio,
    IF(TRY_CAST(abs_latency AS FLOAT) IS NOT NULL,
      CAST(abs_latency AS FLOAT),
      0.0
    ) AS abs_latency,
    IF(TRY_CAST(mfu AS FLOAT) IS NOT NULL,
      CAST(mfu AS FLOAT),
      0.0
    ) AS mfu,
    IF(TRY_CAST(memory_bandwidth AS FLOAT) IS NOT NULL,
      CAST(memory_bandwidth AS FLOAT),
      0.0
    ) AS memory_bandwidth,
    IF(TRY_CAST(dynamo_peak_mem AS FLOAT) IS NOT NULL,
      CAST(dynamo_peak_mem AS FLOAT),
      0.0
    ) AS dynamo_peak_mem,
    IF(TRY_CAST(eager_peak_mem AS FLOAT) IS NOT NULL,
      CAST(eager_peak_mem AS FLOAT),
      0.0
    ) AS eager_peak_mem,
  FROM
    performance_results
  LEFT JOIN accuracy_results ON performance_results.name = accuracy_results.name
    AND performance_results.filename = accuracy_results.filename
    AND performance_results.workflow_id = accuracy_results.workflow_id
)
SELECT DISTINCT
  results.workflow_id,
  -- As the JSON response is pretty big, only return the field if it's needed
  IF(:getJobId, results.job_id, NULL) AS job_id,
  results.suite,
  results.compiler,
  results.name,
  results.speedup,
  results.accuracy,
  results.compilation_latency,
  results.compression_ratio,
  results.abs_latency,
  results.mfu,
  results.memory_bandwidth,
  results.dynamo_peak_mem,
  results.eager_peak_mem,
  results.granularity_bucket,
FROM
  results
WHERE
  ARRAY_CONTAINS(SPLIT(:suites, ','), LOWER(results.suite))
  AND (ARRAY_CONTAINS(SPLIT(:compilers, ','), LOWER(results.compiler)) OR :compilers = '')
  AND (ARRAY_CONTAINS(SPLIT(:branches, ','), results.head_branch) OR :branches = '')
  AND (ARRAY_CONTAINS(SPLIT(:commits, ','), results.head_sha) OR :commits = '')
ORDER BY
  granularity_bucket DESC,
  workflow_id DESC,
  suite ASC,
  compiler ASC,
  name ASC