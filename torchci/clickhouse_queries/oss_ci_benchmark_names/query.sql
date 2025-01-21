--- This query is used by HUD benchmarks dashboards to get the list of experiment names
SELECT
    DISTINCT benchmark_name AS benchmark,
    model_name AS model,
    model_backend AS backend,
    metric_name AS metric,
    benchmark_dtype AS dtype,
    device,
    arch
FROM
    benchmark.oss_ci_benchmark_metadata
WHERE
    timestamp >= toUnixTimestamp({startTime: DateTime64(3) })
    AND timestamp < toUnixTimestamp({stopTime: DateTime64(3) })
    AND repo = {repo: String }
    AND (
        has({benchmarks: Array(String) }, benchmark_name)
        OR empty({benchmarks: Array(String) })
    )
    AND (
        has({models: Array(String) }, model_name)
        OR empty({models: Array(String) })
    )
    AND (
        has({backends: Array(String) }, model_backend)
        OR empty({backends: Array(String) })
    )
    AND (
        has({dtypes: Array(String) }, benchmark_dtype)
        OR empty({dtypes: Array(String) })
    )
    AND (
        NOT has({excludedMetrics: Array(String) }, metric_name)
        OR empty({excludedMetrics: Array(String) })
    )
    AND notEmpty(metric_name)
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
    benchmark,
    backend,
    model,
    metric,
    dtype,
    device
