-- This powers HUD TorchAO benchmarks dashboards
WITH performance_results AS (
    SELECT
        o.model.name AS model,
        o.model.backend AS backend,
        o.metric.name AS metric,
        floor(arrayAvg(o.metric.benchmark_values), 2) AS actual,
        o.head_branch AS head_branch,
        o.head_sha AS head_sha,
        o.workflow_id AS workflow_id,
        o.job_id AS job_id,
        o.timestamp AS timestamp
    FROM
        benchmark.oss_ci_benchmark_v3 o
    WHERE
        o.timestamp >= toUnixTimestamp({startTime: DateTime64(3) })
        AND o.timestamp < toUnixTimestamp({stopTime: DateTime64(3) })
        AND o.repo = {repo: String }
        AND tupleElement(o.benchmark, 'extra_info') [ 'performance' ] = 'true'
        AND (
            has(
                {dtypes: Array(String) },
                tupleElement(o.benchmark, 'extra_info') [ 'quantization' ]
            )
            OR empty({dtypes: Array(String) })
        )
        AND tupleElement(o.benchmark, 'mode') = {mode: String }
        AND tupleElement(o.benchmark, 'extra_info') [ 'device' ] = {device: String }
        AND (
            workflow_id = {workflowId: Int64}
            OR {workflowId: Int64} = 0
        )
        AND (
            o.metric.name in [ 'speedup',
            'compilation_latency',
            'compression_ratio',
            'abs_latency',
            'mfu',
            'memory_bandwidth',
            'dynamo_peak_mem',
            'eager_peak_mem' ]
        )
),
accuracy_results AS (
  SELECT
    o.model.name AS model,
    accuracy,
        o.workflow_id AS workflow_id,
        o.job_id AS job_id,
  FROM
        benchmark.oss_ci_benchmark_v3 o
  WHERE
        o.timestamp >= toUnixTimestamp({startTime: DateTime64(3) })
        AND o.timestamp < toUnixTimestamp({stopTime: DateTime64(3) })
        AND o.repo = {repo: String }
        AND tupleElement(o.benchmark, 'extra_info') [ 'accuracy' ] = 'true'
        AND (
            has(
                {dtypes: Array(String) },
                tupleElement(o.benchmark, 'extra_info') [ 'quantization' ]
            )
            OR empty({dtypes: Array(String) })
        )
        AND tupleElement(o.benchmark, 'mode') = {mode: String }
        AND tupleElement(o.benchmark, 'extra_info') [ 'device' ] = {device: String }
        AND (
            workflow_id = {workflowId: Int64}
            OR {workflowId: Int64} = 0
        )

    --AND accuracy != 'model_fail_to_load'
    --AND accuracy != 'eager_fail_to_run'
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
  FORMAT_ISO8601(
    DATE_TRUNC(: granularity, _event_time)
  ) AS granularity_bucket,
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
