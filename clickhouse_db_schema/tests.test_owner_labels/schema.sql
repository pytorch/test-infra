CREATE TABLE tests.test_owner_labels
(
    `file` String,
    `owner_labels` Array(String),
    `timestamp` DateTime,
    `meta` Tuple(
        bucket String,
        key String)
)
ENGINE = SharedReplacingMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')
ORDER BY file
SETTINGS index_granularity = 8192
