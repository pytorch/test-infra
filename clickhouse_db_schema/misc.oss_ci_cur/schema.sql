CREATE TABLE misc.oss_ci_cur
(
    `created` DateTime64(0, 'UTC'),
    `time` DateTime64(0, 'UTC'),
    `type` String,
    `granularity` String,
    `instance_type` String,
    `usage_type` String,
    `unit` String,
    `value` Float64,
    `extra_info` Map(String, String),
    `tags` Array(String) DEFAULT []
)
ENGINE = SharedReplacingMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')
PARTITION BY toYYYYMM(time)
ORDER BY (type, time, granularity, instance_type, usage_type)
SETTINGS index_granularity = 8192
