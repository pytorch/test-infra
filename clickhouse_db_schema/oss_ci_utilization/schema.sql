-- This query creates the oss_ci_utilization_metadata table on ClickHouse
CREATE TABLE misc.oss_ci_utilization_metadata
(
    -- time stamp info
    `created_at` DateTime64(0, 'UTC'),
    `started_at` DateTime64(0, 'UTC'),
    `ended_at` DateTime64(0, 'UTC'),
    -- github info
    `repo` String DEFAULT 'pytorch/pytorch',
    `run_attempt` UInt32,
    `workflow_id` UInt64,
    `job_id` UInt64,
    `workflow_name` String,
    `job_name` String,
    -- metadata
    `usage_collect_interval` Float32,
    `data_model_version` String,
    `gpu_count` UInt32,
    `cpu_count` UInt32,
    `gpu_type` String,
    `segments` Array(Tuple(level String, name String, start_at DateTime64(0, 'UTC'), end_at DateTime64(0, 'UTC'), extra_info Map(String, String))),
    -- The raw records on S3, this is populated by the s3 replicator
    `_meta` Tuple(bucket String, key String)
)
ENGINE = SharedMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')
PARTITION BY toYYYYMM(started_at)
ORDER BY (workflow_id, job_id, started_at)
-- data exists in the db for a year.
-- time to live is based on created_at which is when the record is inserted in db.
TTL toDate(created_at) + toIntervalYear(1)
SETTINGS index_granularity = 8192

CREATE TABLE misc.oss_ci_time_series(
     -- created_at DateTime when the record is processed in db.
    `created_at` DateTime64(0,'UTC'),
    -- type of time series, for instance, utilization log data is 'utilization'.
    `type` String,
    `tags` Array(string),
    `time_stamp` DateTime64(0,'UTC'),
    `workflow_id` UInt64,
    `job_id` UInt64,
    `run_attempt` UInt32,
    `workflow_template_id` UInt64,
    `job_name` String,
    -- the data stored as raw json string.
    -- Notice in clickhouse the length of string type is not limited.
    `json_data` String,
    -- The raw records on S3, this is populated by the s3 replicator
    `_meta` Tuple(bucket String, key String),
)ENGINE = MergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')
PARTITION BY toYYYYMM(time_stamp)
ORDER BY
    (
        workflow_id,
        job_id,
        type,
        time_stamp,
    )
-- data exists in the db for a year.
-- time to live is based on created_at which is when the record is inserted in db.
TTL toDate(created_at) + toIntervalYear(1)
SETTINGS index_granularity = 8192
