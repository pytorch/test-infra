-- This query is used to get the list of branches and commits used by different
-- OSS CI benchmark experiments. This powers HUD benchmarks dashboards
WITH benchmarks AS (
    SELECT
        o.head_branch AS head_branch,
        o.head_sha AS head_sha,
        o.workflow_id AS id,
        IF(
            EMPTY(o.runners),
            TUPLEELEMENT(o.benchmark, 'extra_info')['device'],
            TUPLEELEMENT(o.runners[1], 'name')
        ) AS device,
        IF(
            EMPTY(o.runners),
            TUPLEELEMENT(o.benchmark, 'extra_info')['arch'],
            TUPLEELEMENT(o.runners[1], 'type')
        ) AS arch,
        o.timestamp AS timestamp,
        TOSTARTOFDAY(FROMUNIXTIMESTAMP(o.timestamp)) AS event_time
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
    REPLACEONE(head_branch, 'refs/heads/', '') AS head_branch,
    head_sha,
    id,
    event_time
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
    head_branch,
    timestamp DESC
