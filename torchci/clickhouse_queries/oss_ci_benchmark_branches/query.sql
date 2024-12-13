-- This query is used to get the list of branches and commits used by different
-- OSS CI benchmark experiments. This powers HUD benchmarks dashboards
WITH benchmarks AS (
    SELECT
        replaceOne(o.head_branch, 'refs/heads/', '') AS head_branch,
        o.head_sha AS head_sha,
        o.workflow_id AS id,
        o.benchmark.name AS benchmark,
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
        toStartOfDay(fromUnixTimestamp(o.timestamp)) AS event_time
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
    DISTINCT head_branch,
    head_sha,
    id,
    benchmark,
    event_time
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
    head_branch,
    event_time DESC
