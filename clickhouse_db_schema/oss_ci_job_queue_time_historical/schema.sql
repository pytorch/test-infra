CREATE TABLE misc.oss_ci_job_queue_time_historical(
    `time` DateTime64(9),
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
    time,
    repo,
    type,
)
TTL toDate(time) + toIntervalYear(5)
SETTINGS index_granularity = 8192
