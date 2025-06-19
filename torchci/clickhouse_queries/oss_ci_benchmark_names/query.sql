--- This query is used by HUD benchmarks dashboards to get the list of experiment names
SELECT DISTINCT
    benchmark_name AS benchmark,
    model_name AS model,
    model_backend AS backend,
    metric_name AS metric,
    benchmark_dtype AS dtype,
    benchmark_mode AS mode,
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
    AND (
        (
            startsWith({device: String }, device)
            AND (
                (
                    {device: String } LIKE '%(private)%'
                    AND device LIKE '%(private)%'
                )
                OR
                (
                    {device: String } NOT LIKE '%(private)%'
                    AND device NOT LIKE '%(private)%'
                )
            )
        )
        OR {device: String } = ''
    )
    AND notEmpty(device)
    AND (
        arch LIKE concat('%', {arch: String }, '%')
        OR {arch: String } = ''
    )
ORDER BY
    benchmark,
    backend,
    model,
    metric,
    dtype,
    mode,
    device
