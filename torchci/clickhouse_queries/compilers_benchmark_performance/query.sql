-- This query is used to get the PT2 benchmark results from different experiments
-- to powers the TorchInductor benchmark dashboard
WITH performance_results AS (
    SELECT
        name,
        IF(speedup = 'infra_error', '', speedup) AS speedup,
        -- Handle the recent burst of infra error
        REPLACE(
            filename,
            CONCAT(
                '_',
                { dtypes: String },
                '_',
                { mode: String },
                '_',
                {device: String },
                '_performance'
            ),
            ''
        ) AS replaced_filename,
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
        filename LIKE CONCAT(
            '%_',
            { dtypes: String },
            '_',
            {mode: String },
            '_',
            {device: String },
            '_performance%'
        )
        AND timestamp >= toUnixTimestamp64Milli({startTime: DateTime64(3) })
        AND timestamp < toUnixTimestamp64Milli({stopTime: DateTime64(3) })
        AND (
            workflow_id = { workflowId: Int64 }
            OR { workflowId: Int64 } = 0
        )
),
accuracy_results AS (
    SELECT
        name,
        accuracy,
        REPLACE(
            filename,
            CONCAT(
                '_',
                { dtypes: String },
                '_',
                {mode: String },
                '_',
                {device: String },
                '_accuracy'
            ),
            ''
        ) AS replaced_filename,
        workflow_id,
        toInt64(job_id) AS job_id,
        timestamp
    FROM
        benchmark.inductor_torch_dynamo_perf_stats
    WHERE
        filename LIKE CONCAT(
            '%_',
            { dtypes: String },
            '_',
            {mode: String },
            '_',
            {device: String },
            '_accuracy%'
        )
        AND timestamp >= toUnixTimestamp64Milli({startTime: DateTime64(3) })
        AND timestamp < toUnixTimestamp64Milli({stopTime: DateTime64(3) })
        AND (
            workflow_id = { workflowId: Int64 }
            OR { workflowId: Int64 } = 0
        )
),
performance_join_accuracy_results AS (
    SELECT
        performance_results.workflow_id AS workflow_id,
        performance_results.job_id AS job_id,
        CASE
            WHEN performance_results.replaced_filename LIKE '%_torchbench' THEN 'torchbench'
            WHEN performance_results.replaced_filename LIKE '%_timm_models' THEN 'timm_models'
            WHEN performance_results.replaced_filename LIKE '%_huggingface' THEN 'huggingface'
            ELSE ''
        END AS suite,
        CASE
            WHEN performance_results.replaced_filename LIKE '%_torchbench' THEN REPLACE(
                performance_results.replaced_filename,
                '_torchbench',
                ''
            )
            WHEN performance_results.replaced_filename LIKE '%_timm_models' THEN REPLACE(
                performance_results.replaced_filename,
                '_timm_models',
                ''
            )
            WHEN performance_results.replaced_filename LIKE '%_huggingface' THEN REPLACE(
                performance_results.replaced_filename,
                '_huggingface',
                ''
            )
            ELSE ''
        END AS compiler,
        performance_results.name,
        IF(speedup != '', toFloat32(speedup), 0.0) AS speedup,
        accuracy,
        IF(
            compilation_latency != '',
            toFloat32(compilation_latency),
            0.0
        ) AS compilation_latency,
        IF(
            compression_ratio != '',
            toFloat32(compression_ratio),
            0.0
        ) AS compression_ratio,
        IF(abs_latency != '', toFloat32(abs_latency), 0.0) AS abs_latency,
        IF(
            dynamo_peak_mem != '',
            toFloat32(dynamo_peak_mem),
            0.0
        ) AS dynamo_peak_mem,
        IF(eager_peak_mem != '', toFloat32(eager_peak_mem), 0.0) AS eager_peak_mem,
        IF(
            performance_results.timestamp != 0,
            performance_results.timestamp,
            accuracy_results.timestamp
        ) AS timestamp
    FROM
        performance_results
        LEFT JOIN accuracy_results ON performance_results.name = accuracy_results.name
        AND performance_results.replaced_filename = accuracy_results.replaced_filename
        AND performance_results.workflow_id = accuracy_results.workflow_id
    WHERE
        accuracy != 'model_fail_to_load'
        AND accuracy != 'eager_fail_to_run'
),
-- This is to accommodate cases where only accuracy results are available, i.e. export
accuracy_join_performance_results AS (
    SELECT
        accuracy_results.workflow_id AS workflow_id,
        accuracy_results.job_id AS job_id,
        CASE
            WHEN accuracy_results.replaced_filename LIKE '%_torchbench' THEN 'torchbench'
            WHEN accuracy_results.replaced_filename LIKE '%_timm_models' THEN 'timm_models'
            WHEN accuracy_results.replaced_filename LIKE '%_huggingface' THEN 'huggingface'
            ELSE ''
        END AS suite,
        CASE
            WHEN accuracy_results.replaced_filename LIKE '%_torchbench' THEN REPLACE(
                accuracy_results.replaced_filename,
                '_torchbench',
                ''
            )
            WHEN accuracy_results.replaced_filename LIKE '%_timm_models' THEN REPLACE(
                accuracy_results.replaced_filename,
                '_timm_models',
                ''
            )
            WHEN accuracy_results.replaced_filename LIKE '%_huggingface' THEN REPLACE(
                accuracy_results.replaced_filename,
                '_huggingface',
                ''
            )
            ELSE ''
        END AS compiler,
        accuracy_results.name,
        0.0 AS speedup,
        accuracy,
        0.0 AS compilation_latency,
        0.0 AS compression_ratio,
        0.0 AS abs_latency,
        0.0 AS dynamo_peak_mem,
        0.0 AS eager_peak_mem,
        accuracy_results.timestamp AS timestamp
    FROM
        accuracy_results
        LEFT JOIN performance_results ON performance_results.name = accuracy_results.name
        AND performance_results.replaced_filename = accuracy_results.replaced_filename
        AND performance_results.workflow_id = accuracy_results.workflow_id
    WHERE
        performance_results.name = ''
        AND accuracy != 'model_fail_to_load'
        AND accuracy != 'eager_fail_to_run'
),
results AS (
    SELECT * FROM performance_join_accuracy_results
    UNION ALL
    SELECT * FROM accuracy_join_performance_results
)
SELECT
    DISTINCT results.workflow_id,
    IF({getJobId: Bool}, results.job_id, 0) AS job_id,
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
        {granularity: String },
        fromUnixTimestamp64Milli(results.timestamp)
    ) AS granularity_bucket
FROM
    results
    LEFT JOIN default .workflow_run w FINAL ON results.workflow_id = w.id
WHERE
    (
        has({suites: Array(String) }, lower(results.suite))
        OR empty({suites: Array(String) })
    )
    AND (
        has(
            {compilers: Array(String) },
            lower(results.compiler)
        )
        OR empty({compilers: Array(String) })
    )
    AND (
        has({branches: Array(String) }, head_branch)
        OR empty({branches: Array(String) })
    )
    AND (
        has({commits: Array(String) }, head_sha)
        OR empty({commits: Array(String) })
    )
ORDER BY
    granularity_bucket DESC,
    workflow_id DESC,
    suite ASC,
    compiler ASC,
    name ASC
