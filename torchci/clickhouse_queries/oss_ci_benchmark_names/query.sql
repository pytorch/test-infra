--- This query is used by HUD benchmarks dashboards to get the list of experiment names
WITH benchmarks AS (
    SELECT
        o.benchmark.name AS benchmark,
        o.model.name AS model,
        o.model.backend AS backend,
        o.metric.name AS metric,
        o.benchmark.dtype AS dtype,
        IF(
            EMPTY(o.runners),
            TUPLEELEMENT(o.benchmark, 'extra_info')['device'],
            TUPLEELEMENT(o.runners[1], 'name')
        ) AS device,
        IF(
            EMPTY(o.runners),
            TUPLEELEMENT(o.benchmark, 'extra_info')['arch'],
            TUPLEELEMENT(o.runners[1], 'type')
        ) AS arch
    FROM
        benchmark.oss_ci_benchmark_v3 o
    WHERE
        o.timestamp >= TOUNIXTIMESTAMP({startTime: DateTime64(3) })
        AND o.timestamp < TOUNIXTIMESTAMP({stopTime: DateTime64(3) })
        AND o.repo = {repo: String }
        AND (
            HAS({benchmarks: Array(String) }, o.benchmark.name)
            OR EMPTY({benchmarks: Array(String) })
        )
        AND (
            HAS({models: Array(String) }, o.model.name)
            OR EMPTY({models: Array(String) })
        )
        AND (
            HAS({backends: Array(String) }, o.model.backend)
            OR EMPTY({backends: Array(String) })
        )
        AND (
            HAS({dtypes: Array(String) }, o.benchmark.dtype)
            OR EMPTY({dtypes: Array(String) })
        )
        AND (
            NOT HAS({excludedMetrics: Array(String) }, o.metric.name)
            OR EMPTY({excludedMetrics: Array(String) })
        )
        AND NOTEMPTY(o.metric.name)
)

SELECT DISTINCT
    benchmark,
    model,
    backend,
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
            IF(EMPTY(arch), 'NVIDIA A100-SXM4-40GB', arch),
            ')'
        ) = {deviceArch: String }
        OR {deviceArch: String } = ''
    )
    AND NOTEMPTY(device)
ORDER BY
    benchmark,
    backend,
    model,
    metric,
    dtype,
    device
