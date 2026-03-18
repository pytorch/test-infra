-- This query is used to get the PT2 benchmark results from different experiments
-- to powers the TorchInductor benchmark dashboard
WITH benchmarks AS (
    SELECT
        workflow_id,
        job_id,
        suite,
        model_name,
        metric_name,
        value,
        metric_extra_info AS extra_info,
        DATE_TRUNC(
            {granularity: String },
            fromUnixTimestamp(timestamp)
        ) AS granularity_bucket,
        -- Filters
        benchmark_dtype,
        benchmark_mode,
        device,
        arch,
        replaceOne(head_branch, 'refs/heads/', '') AS head_branch,
        benchmark_extra_info['output'] AS output,
        REGEXP_REPLACE(
            output,
            CONCAT(
                '_',
                suite,
                '_',
                { dtype: String },
                '_',
                {mode: String },
                '_',
                {device: String },
                '_.*'
            ),
            ''
        ) AS temp
    FROM
        benchmark.oss_ci_benchmark_torchinductor
    WHERE
        timestamp >= toUnixTimestamp({startTime: DateTime64(3) })
        AND timestamp < toUnixTimestamp({stopTime: DateTime64(3) })
        AND (
            has({commits: Array(String) }, head_sha)
            OR empty({commits: Array(String) })
        )
        AND (
            has({suites: Array(String) }, suite)
            OR empty({suites: Array(String) })
        )
        AND (
            workflow_id = {workflowId: Int64}
            OR {workflowId: Int64} = 0
        )
)

SELECT
    workflow_id,
    job_id,
    REGEXP_REPLACE(temp, '.*/', '') AS backend,
    suite,
    model_name AS model,
    metric_name AS metric,
    value,
    extra_info,
    output,
    granularity_bucket
FROM
    benchmarks
WHERE
    (
        has({branches: Array(String) }, head_branch)
        OR empty({branches: Array(String) })
    )
    -- TODO (huydhn): Clean up the output field and how it's used in the query
    -- in 6 months
    AND (
        (
            ({arch: String } = '' OR {arch: String } = 'a100')
            AND output LIKE CONCAT(
                '%\_',
                {dtype: String },
                '\_',
                {mode: String },
                '\_',
                {device: String },
                '\_%'
            )
        )
        OR (
            {arch: String } != ''
            AND output LIKE CONCAT(
                '%\_',
                {dtype: String },
                '\_',
                {mode: String },
                '\_',
                {device: String },
                '\_',
                {arch: String },
                '\_%'
            )
        )
        OR (
            benchmark_dtype = {dtype: String }
            AND benchmark_mode = {mode: String }
            AND device = {device: String }
            AND arch = {arch: String }
        )
    )
ORDER BY
    model_name ASC,
    suite ASC,
    workflow_id DESC,
    benchmark_dtype ASC,
    granularity_bucket DESC
