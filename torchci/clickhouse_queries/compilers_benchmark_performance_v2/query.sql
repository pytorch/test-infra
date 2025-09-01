WITH benchmarks AS (
  SELECT
    workflow_id,
    job_id,
    suite,
    model_name,
    metric_name,
    value,
    metric_extra_info AS extra_info,
    DATE_TRUNC({granularity:String}, fromUnixTimestamp(timestamp)) AS granularity_bucket,
    benchmark_dtype,
    benchmark_mode,
    device,
    arch,
    replaceOne(head_branch, 'refs/heads/', '') AS head_branch,

    benchmark_extra_info['output'] AS output,

    REGEXP_REPLACE(
      benchmark_extra_info['output'],
      CONCAT('_', suite, '_', {dtype:String}, '_', {mode:String}, '_', {device:String}, '_.*'),
      ''
    ) AS temp

  FROM benchmark.oss_ci_benchmark_torchinductor
  WHERE
    timestamp >= toUnixTimestamp({startTime:DateTime64(3)}) AND
    timestamp <  toUnixTimestamp({stopTime:DateTime64(3)}) AND
    (has({commits:Array(String)}, head_sha) OR empty({commits:Array(String)})) AND
    (has({suites:Array(String)}, suite)     OR empty({suites:Array(String)})) AND
    (workflow_id = {workflowId:Int64} OR {workflowId:Int64} = 0)
)

SELECT
  workflow_id,
  job_id,
  REGEXP_REPLACE(temp, '.*/', '') AS backend,
  suite,
  model_name AS model,
  metric_name AS metric,
  value,
  output,
  granularity_bucket,
  extra_info,
FROM benchmarks
WHERE
  (has({branches:Array(String)}, head_branch) OR empty({branches:Array(String)}))
  AND (
    (
      ({arch:String} = '' OR {arch:String} = 'a100') AND
      output LIKE CONCAT('%\_', {dtype:String}, '\_', {mode:String}, '\_', {device:String}, '\_%')
    ) OR (
      {arch:String} != '' AND
      output LIKE CONCAT('%\_', {dtype:String}, '\_', {mode:String}, '\_', {device:String}, '\_', {arch:String}, '\_%')
    ) OR (
      benchmark_dtype = {dtype:String} AND
      benchmark_mode  = {mode:String}  AND
      device          = {device:String} AND
      arch            = {arch:String}
    )
  );
