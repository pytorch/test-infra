-- This query creates the oss_ci_utilization_metadata table on ClickHouse
CREATE TABLE misc.oss_ci_utilization_metadata
(
    `created_at` DateTime64(0, 'UTC'),
    -- github info
    `repo` String DEFAULT 'pytorch/pytorch',
    `workflow_id` UInt64,
    `run_attempt` UInt32,
    `job_id` UInt64,
    `workflow_name` String,
    `job_name` String,
    -- metadata
    `usage_collect_interval` Float32,
    `data_model_version` String,
    `gpu_count` UInt32,
    `cpu_count` UInt32,
    `gpu_type` String DEFAULT 'None',
    `start_at` DateTime64(0, 'UTC'),
    `end_at` DateTime64(0, 'UTC'),
    -- segments are post-job processed data to identify detected test intervals
    `segments` Array(Tuple(level String, name String, start_at DateTime64(0, 'UTC'), end_at DateTime64(0, 'UTC'), extra_info Map(String, String)))  DEFAULT [],
    `tags` Array(String) DEFAULT [],
    -- The raw records on S3, this is populated by the s3 replicator
    `_meta` Tuple(bucket String, key String)
)
ENGINE = SharedMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')
PARTITION BY toYYYYMM(start_at)
ORDER BY (
    workflow_id,
    job_id,
    repo,
    workflow_name,
    job_name,
    start_at)
-- data exists in the db for a year.
-- time to live is based on created_at which is when the record is inserted in db.
TTL toDate(created_at) + toIntervalYear(1)
SETTINGS index_granularity = 8192
