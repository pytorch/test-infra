-- This query is used to get the list of branches and commits used by different
-- OSS CI benchmark experiments. This powers HUD benchmarks dashboards
SELECT
    DISTINCT w.head_branch,
    w.head_sha,
    w.id,
    toStartOfDay(fromUnixTimestamp64Milli(o.timestamp)) AS event_time,
    o.filename
FROM
    benchmark.oss_ci_benchmark_v2 o
    LEFT JOIN default .workflow_run w FINAL ON o.workflow_id = w.id
WHERE
    o.timestamp >= toUnixTimestamp64Milli({startTime: DateTime64(3) })
    AND o.timestamp < toUnixTimestamp64Milli({stopTime: DateTime64(3) })
    AND (
        has({filenames: Array(String) }, o.filename)
        OR empty({filenames: Array(String) })
    )
    -- NB: DEVICE (ARCH) is the display format used by HUD when grouping together these two fields
    AND (
        CONCAT(
            o.device,
            ' (',
            IF(empty(o.arch), 'NVIDIA A100-SXM4-40GB', o.arch),
            ')'
        ) = {deviceArch: String }
        OR {deviceArch: String } = ''
    )
    AND notEmpty(o.metric)
    AND w.html_url LIKE CONCAT('%', {repo: String }, '%')
    AND notEmpty(o.dtype)
    AND notEmpty(o.device)
ORDER BY
    w.head_branch,
    event_time DESC
