CREATE TABLE misc.oss_ci_queue_time_histogram(
    `created_at` DateTime64(0, 'UTC'),
    `time_stamp` DateTime64(0, 'UTC'),
    `type` String,
    `repo` String DEFAULT 'pytorch/pytorch',
    `workflow_name` String,
    `job_name` String,
    `machine_type` String,
    `histogram_version` String,
    `histogram` Array(UInt64),
    `max_queue_time` UInt64,
    `total_count` UInt64,
    `extra_info` Map(String,String)
)
ENGINE = SharedMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')
PARTITION BY toYYYYMM(created_at)
ORDER BY (
    job_name,
    workflow_name,
    machine_type,
    job_name,
    time_stamp,
    repo,
    type,
)
TTL toDate(time_stamp) + toIntervalYear(5)
SETTINGS index_granularity = 8192
