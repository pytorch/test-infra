-- Use another materialize views to migrate TorchInductor dashboard
-- to v3 as I don't want to re-create oss_ci_benchmark_metadata. This
-- is also to make the query faster by keeping only the metric the
-- dashboard needs
CREATE TABLE benchmark.oss_ci_benchmark_torchinductor (
    `device` String,
    `arch` String,
    `model_name` String,
    `suite` String,
    `metric_name` String,
    `value` Float32,
    `metric_extra_info` Map(String, String),
    `benchmark_dtype` String,
    `benchmark_mode` String,
    `benchmark_extra_info` Map(String, String),
    `head_branch` String,
    `head_sha` String,
    `workflow_id` UInt64,
    `job_id` UInt64,
    `timestamp` UInt64,
) ENGINE = MergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')
ORDER BY
    (
        device,
        arch,
        model_name,
        metric_name,
        benchmark_dtype,
        benchmark_mode,
        head_branch,
        workflow_id,
        timestamp
    ) SETTINGS index_granularity = 8192;

CREATE MATERIALIZED VIEW benchmark.oss_ci_benchmark_torchinductor_mv TO benchmark.oss_ci_benchmark_torchinductor AS
SELECT
    IF(
        empty(tupleElement(runners[1], 'name')),
        IF(
            empty(tupleElement(benchmark, 'extra_info')['device']),
            'cpu',
            tupleElement(benchmark, 'extra_info')['device']
        ),
        tupleElement(runners[1], 'name')
    ) AS device,
    IF(
        empty(tupleElement(runners[1], 'type')),
        IF(
            empty(tupleElement(benchmark, 'extra_info')['arch']),
            tupleElement(runners[1], 'cpu_info'),
            tupleElement(benchmark, 'extra_info')['arch']
        ),
        tupleElement(runners[1], 'type')
    ) AS arch,
    tupleElement(model, 'name') AS model_name,
    tupleElement(model, 'origins')[1] AS suite,
    tupleElement(metric, 'name') AS metric_name,
    floor(
        arrayAvg(tupleElement(metric, 'benchmark_values')),
        4
    ) AS value,
    tupleElement(metric, 'extra_info') AS metric_extra_info,
    tupleElement(benchmark, 'dtype') AS benchmark_dtype,
    tupleElement(benchmark, 'mode') AS benchmark_mode,
    tupleElement(benchmark, 'extra_info') AS benchmark_extra_info,
    head_branch AS head_branch,
    head_sha AS head_sha,
    workflow_id AS workflow_id,
    job_id AS job_id,
    timestamp AS timestamp
FROM
    benchmark.oss_ci_benchmark_v3
WHERE
    timestamp >= toUnixTimestamp(toDateTime('2025-06-15 00:00:00'))
    AND tupleElement(benchmark, 'name') = 'TorchInductor'
    AND repo = 'pytorch/pytorch'
    AND (
        tupleElement(metric, 'name') = 'accuracy'
        OR (
            tupleElement(metric, 'name') in ['speedup',
            'compilation_latency',
            'compression_ratio',
            'abs_latency',
            'mfu',
            'memory_bandwidth',
            'dynamo_peak_mem',
            'eager_peak_mem']
            AND tupleElement(benchmark, 'extra_info')['output'] NOT LIKE '%_accuracy%'
        )
    );

INSERT INTO
    benchmark.oss_ci_benchmark_torchinductor
SELECT
    IF(
        empty(tupleElement(runners[1], 'name')),
        IF(
            empty(tupleElement(benchmark, 'extra_info')['device']),
            'cpu',
            tupleElement(benchmark, 'extra_info')['device']
        ),
        tupleElement(runners[1], 'name')
    ) AS device,
    IF(
        empty(tupleElement(runners[1], 'type')),
        IF(
            empty(tupleElement(benchmark, 'extra_info')['arch']),
            tupleElement(runners[1], 'cpu_info'),
            tupleElement(benchmark, 'extra_info')['arch']
        ),
        tupleElement(runners[1], 'type')
    ) AS arch,
    tupleElement(model, 'name') AS model_name,
    tupleElement(model, 'origins')[1] AS suite,
    tupleElement(metric, 'name') AS metric_name,
    floor(arrayAvg(tupleElement(metric, 'benchmark_values')), 4) AS value,
    tupleElement(metric, 'extra_info') AS metric_extra_info,
    tupleElement(benchmark, 'dtype') AS benchmark_dtype,
    tupleElement(benchmark, 'mode') AS benchmark_mode,
    tupleElement(benchmark, 'extra_info') AS benchmark_extra_info,
    head_branch AS head_branch,
    head_sha AS head_sha,
    workflow_id AS workflow_id,
    job_id AS job_id,
    timestamp AS timestamp
FROM
    benchmark.oss_ci_benchmark_v3
WHERE
    tupleElement(benchmark, 'name') = 'TorchInductor'
    AND repo = 'pytorch/pytorch'
    AND (
        tupleElement(metric, 'name') = 'accuracy'
        OR (
            tupleElement(metric, 'name') in ['speedup',
            'compilation_latency',
            'compression_ratio',
            'abs_latency',
            'mfu',
            'memory_bandwidth',
            'dynamo_peak_mem',
            'eager_peak_mem']
            AND tupleElement(benchmark, 'extra_info')['output'] NOT LIKE '%_accuracy%'
        )
    )
    AND timestamp >= toUnixTimestamp(toDateTime('2025-01-01 00:00:00'))
    AND timestamp < toUnixTimestamp(toDateTime('2025-06-17 00:00:00'));
