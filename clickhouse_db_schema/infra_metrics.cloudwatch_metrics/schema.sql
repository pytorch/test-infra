CREATE TABLE infra_metrics.cloudwatch_metrics
(
    `metric_stream_name` LowCardinality(String),
    `account_id` LowCardinality(String),
    `region` LowCardinality(String),
    `namespace` LowCardinality(String),
    `metric_name` LowCardinality(String),
    `dimensions` Map(String, String),
    `timestamp` DateTime,
    `value` Tuple(
        max Float32,
        min Float32,
        sum Float32,
        count Float32),
    `unit` LowCardinality(String),
    `_meta` Tuple(
        bucket String,
        key String)
)
ENGINE = SharedMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')
PARTITION BY toYYYYMM(timestamp)
ORDER BY (namespace, metric_name, timestamp, dimensions)
TTL timestamp + toIntervalMonth(12)
SETTINGS index_granularity = 8192
