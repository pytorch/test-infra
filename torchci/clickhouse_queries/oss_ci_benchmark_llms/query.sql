--- This query is used to get the LLMs benchmark results from different experiments. It
--- queries the TPS and memory bandwidth for each model / quantization combos. This powers
--- the LLMs benchmark dashboard
WITH benchmarks AS (
    SELECT
        replaceOne(o.head_branch, 'refs/heads/', '') AS head_branch,
        o.workflow_id AS workflow_id,
        o.job_id AS job_id,
        o.model.name AS model,
        o.model.backend AS backend,
        o.metric.name AS metric,
        floor(arrayAvg(o.metric.benchmark_values), 2) AS actual,
        floor(toFloat64(o.metric.target_value), 2) AS target,
        o.benchmark.dtype AS dtype,
        IF(
            empty(o.runners),
            tupleElement(o.benchmark, 'extra_info') [ 'device' ],
            tupleElement(o.runners [ 1 ], 'name')
        ) AS device,
        IF(
            empty(o.runners),
            tupleElement(o.benchmark, 'extra_info') [ 'arch' ],
            tupleElement(o.runners [ 1 ], 'type')
        ) AS arch,
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
            has({benchmarks: Array(String) }, o.benchmark.name)
            OR empty({benchmarks: Array(String) })
        )
        AND (
            has({models: Array(String) }, o.model.name)
            OR empty({models: Array(String) })
        )
        AND (
            has({dtypes: Array(String) }, o.benchmark.dtype)
            OR empty({dtypes: Array(String) })
        )
        AND (
            NOT has({excludedMetrics: Array(String) }, o.metric.name)
            OR empty({excludedMetrics: Array(String) })
        )
        AND notEmpty(o.metric.name)
        AND notEmpty(o.benchmark.dtype)
)
SELECT
    DISTINCT workflow_id,
    job_id,
    CONCAT(model, ' ', backend) AS name,
    metric,
    actual,
    target,
    dtype,
    device,
    arch,
    granularity_bucket
FROM
    benchmarks
WHERE
    (
        has({models: Array(String) }, CONCAT(model, ' ', backend))
        OR empty({models: Array(String) })
    )
    AND (
        has({branches: Array(String) }, head_branch)
        OR empty({branches: Array(String) })
    )
    -- NB: DEVICE (ARCH) is the display format used by HUD when grouping together these two fields
    AND (
        CONCAT(
            device,
            ' (',
            IF(empty(arch), 'NVIDIA A100-SXM4-40GB', arch),
            ')'
        ) = {deviceArch: String }
        OR {deviceArch: String } = ''
    )
    AND notEmpty(device)
ORDER BY
    granularity_bucket DESC,
    workflow_id DESC,
    name,
    dtype,
    device
