CREATE TABLE misc.disabled_tests_historical
(
    `day` Date,
    `timestamp` DateTime,
    `name` String,
    `issueNumber` Int32,
    `platforms` Array(String),
    `_meta` Tuple(
        bucket String,
        key String)
)
ENGINE = SharedReplacingMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')
ORDER BY (day, name)
SETTINGS index_granularity = 8192
