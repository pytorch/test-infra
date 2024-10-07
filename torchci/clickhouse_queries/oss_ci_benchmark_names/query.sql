--- This query is used by HUD benchmarks dashboards to get the list of experiment names
SELECT
    DISTINCT o.filename AS filename,
    o.name,
    o.metric,
    o.dtype,
    o.device,
    -- NB: Default to NVIDIA A100-SXM4-40GB for old records without arch column
    IF(empty(o.arch), 'NVIDIA A100-SXM4-40GB', o.arch) AS arch
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
    AND notEmpty(o.metric)
    AND w.html_url LIKE CONCAT('%', {repo: String }, '%')
    AND notEmpty(o.dtype)
    AND notEmpty(o.device)
ORDER BY
    o.filename,
    o.name,
    o.metric,
    o.dtype,
    o.device
