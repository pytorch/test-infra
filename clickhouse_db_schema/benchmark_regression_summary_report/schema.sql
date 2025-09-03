CREATE TABLE benchmark.benchmark_regression_report
(
    `id` UUID DEFAULT generateUUIDv4(),
    `report_id` String, -- unique id for the report config
    `created_at` DateTime64(0, 'UTC') DEFAULT now(),
    `last_record_ts` DateTime64(0, 'UTC'),
    `last_record_commit` String,
    `type` String, -- e.g. 'daily','weekly'
    `status` String, -- e.g. 'no_regression',"regression",'failure'
    `regression_count` UInt32 DEFAULT 0,
    `insufficient_data_count` UInt32 DEFAULT 0,
    `total_count` UInt32 DEFAULT 0,
    `report` String DEFAULT '{}'
)
ENGINE = SharedMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')
PARTITION BY toYYYYMM(report_date)
ORDER BY
(
    report_id,
    type,
    status,
    last_record_ts,
    last_record_commit,
    created_at,
    id
)
TTL created_at + toIntervalYear(10)
SETTINGS index_granularity = 8192;
