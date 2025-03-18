CREATE TABLE misc.oss_ci_queue_time_histogram(
    `type` String,
    `repo` String DEFAULT 'pytorch/pytorch',
    `workflow_name` String,
    `job_name` String,
    `machine_type` String,
    `histogram_version` String,
    `histogram` Array(UInt64),
    `max_queue_time` UInt64,
    `sum_queue_time` UInt64,
    `total_count` UInt64,
    `time` DateTime64(9),
    `extra_info` Map(String,String)
)
ENGINE = SharedMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')
PARTITION BY toYYYYMM(time)
ORDER BY (
    type,
    repo,
    time,
    machine_type,
    job_name,
    workflow_name,
)
TTL toDate(time) + toIntervalYear(5)
SETTINGS index_granularity = 8192
