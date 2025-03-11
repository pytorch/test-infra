-- This query is used to get the PT2 benchmark results from different experiments
-- to powers the TorchInductor benchmark dashboard

-- Pre-compute the constants used throughout the query
WITH constants AS (
    SELECT
        {dtypes: String} AS dtypes,
        {mode: String} AS mode,
        {device: String} AS device,
        toUnixTimestamp64Milli({startTime: DateTime64(3)}) AS start_ts,
        toUnixTimestamp64Milli({stopTime: DateTime64(3)}) AS stop_ts,
        {workflowId: Int64} AS workflow_id,
        {granularity: String} AS granularity,
        {getJobId: Bool} AS get_job_id
),

-- Extract common filename pattern construction
filename_patterns AS (
    SELECT
        CONCAT('%_', dtypes, '_', mode, '_', device, '_performance%') AS perf_pattern,
        CONCAT('_', dtypes, '_', mode, '_', device, '_performance') AS perf_replace,
        CONCAT('%_', dtypes, '_', mode, '_', device, '_accuracy%') AS acc_pattern,
        CONCAT('_', dtypes, '_', mode, '_', device, '_accuracy') AS acc_replace
    FROM constants
),

-- Add index hints and optimize the performance results query
performance_results AS (
    SELECT
        name,
        IF(speedup = 'infra_error', '', speedup) AS speedup,
        REPLACE(filename, (SELECT perf_replace FROM filename_patterns), '') AS replaced_filename,
        compilation_latency,
        compression_ratio,
        abs_latency,
        dynamo_peak_mem,
        eager_peak_mem,
        workflow_id,
        toInt64(job_id) AS job_id,
        timestamp
    FROM
        benchmark.inductor_torch_dynamo_perf_stats
    WHERE
        filename LIKE (SELECT perf_pattern FROM filename_patterns)
        AND timestamp >= (SELECT start_ts FROM constants)
        AND timestamp < (SELECT stop_ts FROM constants)
        AND (
            workflow_id = (SELECT workflow_id FROM constants)
            OR (SELECT workflow_id FROM constants) = 0
        )
),

-- Optimize accuracy results query similarly
accuracy_results AS (
    SELECT
        name,
        accuracy,
        REPLACE(filename, (SELECT acc_replace FROM filename_patterns), '') AS replaced_filename,
        workflow_id,
        toInt64(job_id) AS job_id,
        timestamp
    FROM
        benchmark.inductor_torch_dynamo_perf_stats
    WHERE
        filename LIKE (SELECT acc_pattern FROM filename_patterns)
        AND timestamp >= (SELECT start_ts FROM constants)
        AND timestamp < (SELECT stop_ts FROM constants)
        AND (
            workflow_id = (SELECT workflow_id FROM constants)
            OR (SELECT workflow_id FROM constants) = 0
        )
),

-- Extract common suite and compiler determination logic
suite_compiler_mapping AS (
    -- For performance results
    SELECT
        p.name,
        p.replaced_filename,
        p.workflow_id,
        p.job_id,
        p.speedup,
        p.compilation_latency,
        p.compression_ratio,
        p.abs_latency,
        p.dynamo_peak_mem,
        p.eager_peak_mem,
        p.timestamp,
        multiIf(
            p.replaced_filename LIKE '%_torchbench', 'torchbench',
            p.replaced_filename LIKE '%_timm_models', 'timm_models',
            p.replaced_filename LIKE '%_huggingface', 'huggingface',
            ''
        ) AS suite,
        multiIf(
            p.replaced_filename LIKE '%_torchbench', REPLACE(p.replaced_filename, '_torchbench', ''),
            p.replaced_filename LIKE '%_timm_models', REPLACE(p.replaced_filename, '_timm_models', ''),
            p.replaced_filename LIKE '%_huggingface', REPLACE(p.replaced_filename, '_huggingface', ''),
            ''
        ) AS compiler
    FROM performance_results p
),

-- Optimized performance join accuracy
performance_join_accuracy_results AS (
    SELECT
        s.workflow_id,
        s.job_id,
        s.suite,
        s.compiler,
        s.name,
        IF(s.speedup != '', toFloat32(s.speedup), 0.0) AS speedup,
        a.accuracy,
        IF(s.compilation_latency != '', toFloat32(s.compilation_latency), 0.0) AS compilation_latency,
        IF(s.compression_ratio != '', toFloat32(s.compression_ratio), 0.0) AS compression_ratio,
        IF(s.abs_latency != '', toFloat32(s.abs_latency), 0.0) AS abs_latency,
        IF(s.dynamo_peak_mem != '', toFloat32(s.dynamo_peak_mem), 0.0) AS dynamo_peak_mem,
        IF(s.eager_peak_mem != '', toFloat32(s.eager_peak_mem), 0.0) AS eager_peak_mem,
        IF(s.timestamp != 0, s.timestamp, a.timestamp) AS timestamp
    FROM
        suite_compiler_mapping s
        LEFT JOIN accuracy_results a ON s.name = a.name
            AND s.replaced_filename = a.replaced_filename
            AND s.workflow_id = a.workflow_id
    WHERE
        a.accuracy != 'model_fail_to_load'
        AND a.accuracy != 'eager_fail_to_run'
),

-- For cases with only accuracy results available
accuracy_only_results AS (
    SELECT
        a.workflow_id,
        a.job_id,
        multiIf(
            a.replaced_filename LIKE '%_torchbench', 'torchbench',
            a.replaced_filename LIKE '%_timm_models', 'timm_models',
            a.replaced_filename LIKE '%_huggingface', 'huggingface',
            ''
        ) AS suite,
        multiIf(
            a.replaced_filename LIKE '%_torchbench', REPLACE(a.replaced_filename, '_torchbench', ''),
            a.replaced_filename LIKE '%_timm_models', REPLACE(a.replaced_filename, '_timm_models', ''),
            a.replaced_filename LIKE '%_huggingface', REPLACE(a.replaced_filename, '_huggingface', ''),
            ''
        ) AS compiler,
        a.name,
        0.0 AS speedup,
        a.accuracy,
        0.0 AS compilation_latency,
        0.0 AS compression_ratio,
        0.0 AS abs_latency,
        0.0 AS dynamo_peak_mem,
        0.0 AS eager_peak_mem,
        a.timestamp
    FROM
        accuracy_results a
        LEFT ANTI JOIN performance_results p ON a.name = p.name
            AND a.replaced_filename = p.replaced_filename
            AND a.workflow_id = p.workflow_id
    WHERE
        a.accuracy != 'model_fail_to_load'
        AND a.accuracy != 'eager_fail_to_run'
),

-- Combine both result sets
results AS (
    SELECT * FROM performance_join_accuracy_results
    UNION ALL
    SELECT * FROM accuracy_only_results
)

-- Final result with optimized ordering and filtering
SELECT
    results.workflow_id,
    IF((SELECT get_job_id FROM constants), results.job_id, 0) AS job_id,
    results.suite,
    results.compiler,
    results.name,
    results.speedup,
    results.accuracy,
    results.compilation_latency,
    results.compression_ratio,
    results.abs_latency,
    results.dynamo_peak_mem,
    results.eager_peak_mem,
    DATE_TRUNC(
        (SELECT granularity FROM constants),
        fromUnixTimestamp64Milli(results.timestamp)
    ) AS granularity_bucket
FROM
    results
    LEFT JOIN default.workflow_run w FINAL ON results.workflow_id = w.id
WHERE
    (
        has({suites: Array(String)}, lower(results.suite))
        OR empty({suites: Array(String)})
    )
    AND (
        has({compilers: Array(String)}, lower(results.compiler))
        OR empty({compilers: Array(String)})
    )
    AND (
        has({branches: Array(String)}, w.head_branch)
        OR empty({branches: Array(String)})
    )
    AND (
        has({commits: Array(String)}, w.head_sha)
        OR empty({commits: Array(String)})
    )
GROUP BY
    results.workflow_id,
    job_id,
    results.suite,
    results.compiler,
    results.name,
    results.speedup,
    results.accuracy,
    results.compilation_latency,
    results.compression_ratio,
    results.abs_latency,
    results.dynamo_peak_mem,
    results.eager_peak_mem,
    granularity_bucket
ORDER BY
    granularity_bucket DESC,
    results.workflow_id DESC,
    results.suite ASC,
    results.compiler ASC,
    results.name ASC
