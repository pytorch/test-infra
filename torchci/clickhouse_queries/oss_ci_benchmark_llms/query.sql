--- This query is used to get the LLMs benchmark results from different experiments. It
--- queries the TPS and memory bandwidth for each model / quantization combos. This powers
--- the LLMs benchmark dashboard
SELECT
    DISTINCT o.workflow_id AS workflow_id,
    -- As the JSON response is pretty big, only return the field if it's needed
    IF({getJobId: Bool}, o.job_id, '') AS job_id,
    o.name,
    o.metric,
    floor(toFloat64(o.actual), 2) AS actual,
    floor(toFloat64(o.target), 2) AS target,
    DATE_TRUNC(
        {granularity: String },
        fromUnixTimestamp64Milli(o.timestamp)
    ) AS granularity_bucket,
    o.dtype,
    o.device,
    -- NB: Default to NVIDIA A100-SXM4-40GB for old records without arch column
    IF(empty(o.arch), 'NVIDIA A100-SXM4-40GB', o.arch) as arch
FROM
    benchmark.oss_ci_benchmark_v2 o
    LEFT JOIN default .workflow_run w FINAL ON o.workflow_id = w.id
WHERE
    o.timestamp >= toUnixTimestamp64Milli({startTime: DateTime64(3) })
    AND o.timestamp < toUnixTimestamp64Milli({stopTime: DateTime64(3) })
    AND (
        has({branches: Array(String) }, w.head_branch)
        OR empty({branches: Array(String) })
    )
    AND (
        has({commits: Array(String) }, w.head_sha)
        OR empty({commits: Array(String) })
    )
    AND (
        has({filenames: Array(String) }, o.filename)
        OR empty({filenames: Array(String) })
    )
    AND (
        has({names: Array(String) }, o.name)
        OR empty({names: Array(String) })
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
    AND (
        has({dtypes: Array(String) }, o.dtype)
        OR empty({dtypes: Array(String) })
    )
    AND (
        NOT has({excludedMetrics: Array(String) }, o.metric)
        OR empty({excludedMetrics: Array(String) })
    )
    AND notEmpty(o.metric)
    AND notEmpty(o.dtype)
    AND notEmpty(o.device)
    AND w.html_url LIKE CONCAT('%', {repo: String }, '%')
ORDER BY
    granularity_bucket DESC,
    workflow_id DESC,
    name,
    dtype,
    device
