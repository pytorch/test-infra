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
    workflow_id,
    CAST(job_id AS INT) AS job_id,
  FROM
    inductor.torch_dynamo_perf_stats
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
    inductor.torch_dynamo_perf_stats
  WHERE
    filename LIKE '%_accuracy'
    AND filename LIKE CONCAT(
      '%_', : dtypes, '_', : mode, '_', : device,
      '_%'
    )
    AND _event_time >= PARSE_DATETIME_ISO8601(:startTime)
    AND _event_time < PARSE_DATETIME_ISO8601(:stopTime)
    AND (workflow_id = :workflowId OR :workflowId = 0)
),
results AS (
  SELECT
    accuracy_results.workflow_id AS workflow_id,
    accuracy_results.job_id AS job_id,
    CASE
      WHEN accuracy_results.filename LIKE '%_torchbench' THEN 'torchbench'
      WHEN accuracy_results.filename LIKE '%_timm_models' THEN 'timm_models'
      WHEN accuracy_results.filename LIKE '%_huggingface' THEN 'huggingface'
      ELSE NULL
    END AS suite,
    CASE
      WHEN accuracy_results.filename LIKE '%_torchbench' THEN REPLACE(
        accuracy_results.filename, '_torchbench'
      )
      WHEN accuracy_results.filename LIKE '%_timm_models' THEN REPLACE(
        accuracy_results.filename, '_timm_models'
      )
      WHEN accuracy_results.filename LIKE '%_huggingface' THEN REPLACE(
        accuracy_results.filename, '_huggingface'
      )
      ELSE NULL
    END AS compiler,
    accuracy_results.name,
    IF(TRY_CAST(speedup AS FLOAT) IS NOT NULL,
      CAST(speedup AS FLOAT),
      0.0
    ) AS speedup,
    accuracy,
    IF(TRY_CAST(compilation_latency AS FLOAT) IS NOT NULL,
      CAST(compilation_latency AS FLOAT),
      0.0
    ) AS compilation_latency,
    IF(TRY_CAST(compression_ratio AS FLOAT) IS NOT NULL,
      CAST(compression_ratio AS FLOAT),
      0.0
    ) AS compression_ratio,
  FROM
    accuracy_results
    LEFT JOIN performance_results ON performance_results.name = accuracy_results.name
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
  FORMAT_ISO8601(
    DATE_TRUNC(: granularity, w._event_time)
  ) AS granularity_bucket,
FROM
  results LEFT JOIN commons.workflow_run w ON results.workflow_id = w.id
WHERE
  ARRAY_CONTAINS(SPLIT(:suites, ','), LOWER(results.suite))
  AND (ARRAY_CONTAINS(SPLIT(:compilers, ','), LOWER(results.compiler)) OR :compilers = '')
  AND (ARRAY_CONTAINS(SPLIT(:branches, ','), head_branch) OR :branches = '')
  AND (ARRAY_CONTAINS(SPLIT(:commits, ','), head_sha) OR :commits = '')  
ORDER BY
  granularity_bucket DESC,
  workflow_id DESC,
  suite ASC,
  compiler ASC,
  name ASC
