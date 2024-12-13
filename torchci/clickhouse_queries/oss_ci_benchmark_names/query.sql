--- This query is used by HUD benchmarks dashboards to get the list of experiment names
WITH benchmarks AS (
    SELECT
        o.benchmark.name AS benchmark,
        o.model.name AS model,
        o.model.backend AS backend,
        o.metric.name AS metric,
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
        ) AS arch
    FROM
        benchmark.oss_ci_benchmark_v3 o
    WHERE
        o.timestamp >= toUnixTimestamp({startTime: DateTime64(3) })
        AND o.timestamp < toUnixTimestamp({stopTime: DateTime64(3) })
        AND o.repo = {repo: String }
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
    DISTINCT benchmark,
    CONCAT(model, ' ', backend) AS name,
    metric,
    dtype,
    device,
    arch
FROM
    benchmarks
WHERE
    -- NB: DEVICE (ARCH) is the display format used by HUD when grouping together these two fields
    (
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
    benchmark,
    name,
    metric,
    dtype,
    device
