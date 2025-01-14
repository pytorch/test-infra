-- This table is used to speed-up the performance of oss_ci_benchmark_names and
-- and oss_ci_benchmark_branches queries
CREATE TABLE benchmark.oss_ci_benchmark_metadata (
    `repo` String,
    `benchmark_name` String,
    `benchmark_dtype` String,
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
        model_name,
        model_backend,
        device,
        arch,
        metric_name,
        head_branch,
        timestamp
    ) SETTINGS index_granularity = 8192;

CREATE MATERIALIZED VIEW benchmark.oss_ci_benchmark_metadata_mv TO benchmark.oss_ci_benchmark_metadata AS
SELECT
    o.repo AS repo,
    o.benchmark.name AS benchmark_name,
    o.benchmark.dtype AS benchmark_dtype,
    o.model.name AS model_name,
    o.model.backend AS model_backend,
    IF(
        empty(o.runners),
        tupleElement(o.benchmark, 'extra_info') [ 'device' ],
        tupleElement(o.runners [ 1 ], 'name')
    ) AS device,
    IF(
        empty(o.runners),
        tupleElement(o.benchmark, 'extra_info') [ 'arch' ],
        tupleElement(o.runners [ 1 ], 'type')
    ) AS arch,
    o.metric.name AS metric_name,
    o.head_branch AS head_branch,
    o.head_sha AS head_sha,
    o.workflow_id AS workflow_id,
    o.timestamp AS timestamp
FROM
    benchmark.oss_ci_benchmark_v3 o;

-- Below is the SQL query to backfill the view with all data from 2024 onward
INSERT INTO
    benchmark.oss_ci_benchmark_metadata
SELECT
    o.repo AS repo,
    o.benchmark.name AS benchmark_name,
    o.benchmark.dtype AS benchmark_dtype,
    o.model.name AS model_name,
    o.model.backend AS model_backend,
    IF(
        empty(o.runners),
        tupleElement(o.benchmark, 'extra_info') [ 'device' ],
        tupleElement(o.runners [ 1 ], 'name')
    ) AS device,
    IF(
        empty(o.runners),
        tupleElement(o.benchmark, 'extra_info') [ 'arch' ],
        tupleElement(o.runners [ 1 ], 'type')
    ) AS arch,
    o.metric.name AS metric_name,
    o.head_branch AS head_branch,
    o.head_sha AS head_sha,
    o.workflow_id AS workflow_id,
    o.timestamp AS timestamp
FROM
    benchmark.oss_ci_benchmark_v3 o
WHERE
    o.timestamp > toUnixTimestamp(toDateTime('2024-01-01 00:00:00'));
