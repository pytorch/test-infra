CREATE TABLE benchmark.benchmark_regression_report
(
    `id` UUID DEFAULT generateUUIDv4(),
    `report_id` String,
    `created_at` DateTime64(0, 'UTC') DEFAULT now(),
    `last_record_ts` DateTime64(0, 'UTC'),
    `stamp` Date DEFAULT toDate(last_record_ts),
    `last_record_commit` String,
    `type` String,
    `status` String,
    `regression_count` UInt32 DEFAULT 0,
    `insufficient_data_count` UInt32 DEFAULT 0,
    `suspected_regression_count` UInt32 DEFAULT 0,
    `total_count` UInt32 DEFAULT 0,
    `metadata` String DEFAULT '{}',
    `device_info` Array(String) DEFAULT [],
    `labels` Array(String) DEFAULT [],
    `repo` String,
    `report` String DEFAULT '{}',
    INDEX idx_device_keys device_info TYPE set(0) GRANULARITY 64,
    INDEX idx_labels labels TYPE set(0) GRANULARITY 64
)
ENGINE = SharedMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')
PARTITION BY toYYYYMM(created_at)
ORDER BY (report_id, type, stamp, status, last_record_ts, last_record_commit, created_at, repo, id)
TTL created_at + toIntervalYear(10)
SETTINGS index_granularity = 8192
