--- This query is used to get the LLMs benchmark results from different experiments. It
--- queries the TPS and memory bandwidth for each model / quantization combos. This powers
--- the LLMs benchmark dashboard
WITH benchmarks AS (
    SELECT
        REPLACEONE(o.head_branch, 'refs/heads/', '') AS head_branch,
        o.workflow_id AS workflow_id,
        o.job_id AS job_id,
        o.model.name AS model,
        o.model.backend AS backend,
        o.model.origins AS origins,
        o.metric.name AS metric,
        FLOOR(ARRAYAVG(o.metric.benchmark_values), 2) AS actual,
        FLOOR(TOFLOAT64(o.metric.target_value), 2) AS target,
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
        ) AS arch,
        IF(
            TUPLEELEMENT(o.benchmark, 'extra_info')['compile'] = '',
            'true',  -- Default to true
            TUPLEELEMENT(o.benchmark, 'extra_info')['compile']
        ) AS use_torch_compile,
        DATE_TRUNC(
            {granularity: String },
            FROMUNIXTIMESTAMP(o.timestamp)
        ) AS granularity_bucket
    FROM
        benchmark.oss_ci_benchmark_v3 o
    WHERE
        o.timestamp >= TOUNIXTIMESTAMP({startTime: DateTime64(3) })
        AND o.timestamp < TOUNIXTIMESTAMP({stopTime: DateTime64(3) })
        AND o.repo = {repo: String }
        AND (
            HAS({commits: Array(String) }, o.head_sha)
            OR EMPTY({commits: Array(String) })
        )
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
    workflow_id,
    job_id,
    model,
    backend,
    origins,
    metric,
    actual,
    target,
    dtype,
    device,
    arch,
    TOBOOL(use_torch_compile) AS use_torch_compile,
    granularity_bucket
FROM
    benchmarks
WHERE
    (
        HAS({branches: Array(String) }, head_branch)
        OR EMPTY({branches: Array(String) })
    )
    -- NB: DEVICE (ARCH) is the display format used by HUD when grouping together these two fields
    AND (
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
    granularity_bucket DESC,
    workflow_id DESC,
    backend,
    model,
    dtype,
    device
