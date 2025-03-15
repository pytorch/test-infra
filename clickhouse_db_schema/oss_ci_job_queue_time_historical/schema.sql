CREATE TABLE misc.oss_ci_job_queue_time_historical(
    `queue_s` UInt64,
    `repo` String DEFAULT 'pytorch/pytorch',
    `workflow_name` String,
    `job_name` String,
    `machine_type` String
    `time` DateTime64(9),
    -- The raw records on S3, this is populated by the s3 replicator
    `_meta` Tuple(bucket String, key String)
)
ENGINE = SharedMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')
PARTITION BY toYYYYMM(time)
ORDER BY (
    repo,
    workflow_name,
    job_name,
    machine_type,
    queue_s,
    time,
)
TTL toDate(time) + toIntervalYear(5)
SETTINGS index_granularity = 8192
