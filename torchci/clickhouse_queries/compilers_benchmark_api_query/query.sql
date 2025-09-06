
SELECT
  workflow_id,
  job_id,
  head_sha,
  replaceOne(head_branch, 'refs/heads/', '') AS head_branch,
  suite,
  model_name  AS model,
  metric_name AS metric,
  value,
  metric_extra_info              AS extra_info,
  benchmark_extra_info['output'] AS output,
  timestamp,
  DATE_TRUNC({granularity: String}, fromUnixTimestamp(timestamp)) AS granularity_bucket
FROM benchmark.oss_ci_benchmark_torchinductor
WHERE
  (head_sha) IN (
    SELECT DISTINCT
      head_sha
    FROM benchmark.oss_ci_benchmark_torchinductor
    PREWHERE
      timestamp >= toUnixTimestamp({startTime: DateTime64(3,)})
      AND timestamp <  toUnixTimestamp({stopTime: DateTime64(3)})
  )
  AND (
    has({branches: Array(String)}, replaceOne(head_branch, 'refs/heads/', ''))
    OR empty({branches: Array(String)})
  )
  AND benchmark_dtype = {dtype: String}
  AND benchmark_mode = {mode: String}
  AND device = {device: String}
  AND positionCaseInsensitive(arch,{arch: String}) > 0

SETTINGS session_timezone = 'UTC';
