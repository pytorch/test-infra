-- This query creates the oss_ci_benchmark_v3 table on ClickHouse
CREATE TABLE misc.oss_ci_utilization_metadata
(
    `created_at` DateTime64(0, 'UTC'),
    `started_at` DateTime64(0, 'UTC'),
    `ended_at` DateTime64(0, 'UTC'),
    `repo` String DEFAULT 'pytorch/pytorch',
    `run_attempt` UInt32,
    `workflow_id` UInt64,
    `job_id` UInt64,
    `workflow_name` String,
    `job_name` String,
    `usage_collect_interval` Float32,
    `data_model_version` String,
    `runner_info` Tuple(
        gpu_count UInt32,
        cpu_count UInt32,
        gpu_types Array(String),
        extra_info Map(String, String)
    ),
    `segments` Array(Tuple(level String, name String, start_at DateTime64(0, 'UTC'), end_at DateTime64(0, 'UTC'), extra_info Map(String, String))),
    `_meta` Tuple(bucket String, key String)
)
ENGINE = SharedMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')
PARTITION BY toYYYYMM(started_at)
ORDER BY (workflow_id, job_id, started_at)
SETTINGS index_granularity = 8192

CREATE TABLE misc.oss_ci_utilization_time_series(
     -- created_at DateTime when the record is processed in db.
    `created_at` DateTime64(0,'UTC'),
    `time_stamp` DateTime64(0,'UTC'),
    `workflow_id` UInt64,
    `job_id` UInt64,
    `run_attempt` UInt32,
    -- the type of time series, for utilization
    `type` String,
    `workflow_template_id` UInt64,
    `job_name` String,
    -- the data stored as raw json string.
    `json_data` String,
    -- The raw records on S3, this is populated by the s3 replicator
    `_meta` Tuple(bucket String, key String),
)ENGINE = MergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')
PARTITION BY toYYYYMM(time_stamp)
ORDER BY
    (
        workflow_id,
        job_id,
        time_stamp,
    ) SETTINGS index_granularity = 8192
