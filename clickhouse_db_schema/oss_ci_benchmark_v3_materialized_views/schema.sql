-- This table is used to speed-up the performance of oss_ci_benchmark_names and
-- and oss_ci_benchmark_branches queries
CREATE TABLE benchmark.oss_ci_benchmark_metadata (
    `repo` String,
    `benchmark_name` String,
    `benchmark_dtype` String,
    `benchmark_mode` String,
    `model_name` String,
    `model_backend` String,
    `device` String,
    `arch` String,
    `metric_name` String,
    `head_branch` String,
    `head_sha` String,
    `workflow_id` UInt64,
    `timestamp` UInt64,
) ENGINE = MergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')
ORDER BY
    (
        repo,
        benchmark_name,
        benchmark_dtype,
        benchmark_mode,
        model_name,
        model_backend,
        device,
        arch,
        metric_name,
        head_branch,
        workflow_id,
        timestamp
    ) SETTINGS index_granularity = 8192;

CREATE MATERIALIZED VIEW benchmark.oss_ci_benchmark_metadata_mv TO benchmark.oss_ci_benchmark_metadata AS
SELECT
    repo AS repo,
    tupleElement(benchmark, 'name') AS benchmark_name,
    tupleElement(benchmark, 'dtype') AS benchmark_dtype,
    tupleElement(benchmark, 'mode') AS benchmark_mode,
    tupleElement(model, 'name') AS model_name,
    tupleElement(model, 'backend') AS model_backend,
    IF(
        empty(runners),
        tupleElement(benchmark, 'extra_info') [ 'device' ],
        tupleElement(runners [ 1 ], 'name')
    ) AS device,
    IF(
        empty(runners),
        tupleElement(benchmark, 'extra_info') [ 'arch' ],
        tupleElement(runners [ 1 ], 'type')
    ) AS arch,
    tupleElement(metric, 'name') AS metric_name,
    head_branch AS head_branch,
    head_sha AS head_sha,
    workflow_id AS workflow_id,
    timestamp AS timestamp
FROM
    benchmark.oss_ci_benchmark_v3
WHERE
    timestamp >= toUnixTimestamp(toDateTime('2025-02-19 00:00:00'))
    AND tupleElement(benchmark, 'name') != 'sccache_stats';

-- Below is the SQL query to backfill the view with all data from 2024 onward
INSERT INTO
    benchmark.oss_ci_benchmark_metadata
SELECT
    repo AS repo,
    tupleElement(benchmark, 'name') AS benchmark_name,
    tupleElement(benchmark, 'dtype') AS benchmark_dtype,
    tupleElement(benchmark, 'mode') AS benchmark_mode,
    tupleElement(model, 'name') AS model_name,
    tupleElement(model, 'backend') AS model_backend,
    IF(
        empty(runners),
        tupleElement(benchmark, 'extra_info') [ 'device' ],
        tupleElement(runners [ 1 ], 'name')
    ) AS device,
    IF(
        empty(runners),
        tupleElement(benchmark, 'extra_info') [ 'arch' ],
        tupleElement(runners [ 1 ], 'type')
    ) AS arch,
    tupleElement(metric, 'name') AS metric_name,
    head_branch AS head_branch,
    head_sha AS head_sha,
    workflow_id AS workflow_id,
    timestamp AS timestamp
FROM
    benchmark.oss_ci_benchmark_v3
WHERE
    tupleElement(benchmark, 'name') != 'sccache_stats';
