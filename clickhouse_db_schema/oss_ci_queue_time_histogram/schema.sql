CREATE TABLE misc.oss_ci_queue_time_histogram(
    `created_at` DateTime64(0, 'UTC'),
    `time_stamp` DateTime64(0, 'UTC'),
    `repo` String DEFAULT 'pytorch/pytorch',
    `workflow_name` String,
    `job_name` String,
    `machine_type` String,
    `histogram_version` String,
    `histogram` Array(UInt64),
    `max_queue_time` UInt64,
    `total_count` UInt64
)
ENGINE = SharedMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')
PARTITION BY toYYYYMM(created_at)
ORDER BY (
    repo,
    workflow_name,
    machine_type
    job_name,
    time_stamp
)
TTL toDate(time_stamp) + toIntervalYear(5)
SETTINGS index_granularity = 8192
