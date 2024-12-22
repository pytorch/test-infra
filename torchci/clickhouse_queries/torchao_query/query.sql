-- This powers HUD TorchAO benchmarks dashboards
WITH benchmarks AS (
    SELECT
        o.model.origins [ 1 ] AS suite,
        o.model.name AS model,
        tupleElement(o.benchmark, 'extra_info') [ 'quantization' ] AS dtype,
        o.metric.name AS metric,
        floor(arrayAvg(o.metric.benchmark_values), 2) AS value,
        tupleElement(o.metric, 'extra_info') AS extra_info,
        replaceOne(o.head_branch, 'refs/heads/', '') AS head_branch,
        o.head_sha AS head_sha,
        o.workflow_id AS workflow_id,
        o.job_id AS job_id,
        DATE_TRUNC(
            {granularity: String },
            fromUnixTimestamp(o.timestamp)
        ) AS granularity_bucket
    FROM
        benchmark.oss_ci_benchmark_v3 o
    WHERE
        o.timestamp >= toUnixTimestamp({startTime: DateTime64(3) })
        AND o.timestamp < toUnixTimestamp({stopTime: DateTime64(3) })
        AND o.repo = {repo: String }
        AND (
            has({commits: Array(String) }, o.head_sha)
            OR empty({commits: Array(String) })
        )
        AND (
            has({suites: Array(String) }, suite)
            OR empty({suites: Array(String) })
        )
        AND (
            has({dtypes: Array(String) }, dtype)
            OR empty({dtypes: Array(String) })
        )
        AND tupleElement(o.benchmark, 'mode') = {mode: String }
        AND tupleElement(o.benchmark, 'extra_info') [ 'device' ] = {device: String }
        AND (
            workflow_id = {workflowId: Int64}
            OR {workflowId: Int64} = 0
        )
        AND (
            o.metric.name in [ 'accuracy',
            'speedup',
            'compilation_latency',
            'compression_ratio',
            'abs_latency',
            'mfu',
            'memory_bandwidth',
            'dynamo_peak_mem',
            'eager_peak_mem' ]
        )
)
SELECT
    suite,
    model,
    dtype,
    metric,
    value,
    extra_info,
    workflow_id,
    job_id,
    granularity_bucket
FROM
    benchmarks
WHERE
    (
        has({branches: Array(String) }, head_branch)
        OR empty({branches: Array(String) })
    )
ORDER BY
    granularity_bucket DESC,
    workflow_id DESC,
    suite ASC,
    dtype ASC,
    model ASC
