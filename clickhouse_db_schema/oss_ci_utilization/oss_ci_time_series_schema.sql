-- This query creates the oss_ci_time_series table on ClickHouse
CREATE TABLE misc.oss_ci_time_series(
     -- created_at DateTime when the record is processed in db.
    `created_at` DateTime64(0,'UTC'),
    -- type of time series, for instance, utilization log data is 'utilization'.
    `type` String,
    `tags` Array(String) DEFAULT [],
    `time_stamp` DateTime64(0,'UTC'),
    `repo` String DEFAULT 'pytorch/pytorch',
    `workflow_id` UInt64,
    `run_attempt` UInt32,
    `job_id` UInt64,
    `workflow_name` String,
    `job_name` String,
    -- the data stored as raw json string.
    -- Notice in clickhouse the length of string type is not limited.
    `json_data` String DEFAULT '{}',
    -- The raw records on S3, this is populated by the s3 replicator
    `_meta` Tuple(bucket String, key String),
)ENGINE = SharedMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')
PARTITION BY toYYYYMM(time_stamp)
ORDER BY
    (
        workflow_id,
        job_id,
        repo,
        workflow_name,
        job_name,
        type,
        time_stamp,
    )
-- data exists in the db for a year.
-- time to live is based on created_at which is when the record is inserted in db.
TTL toDate(created_at) + toIntervalYear(1)
SETTINGS index_granularity = 8192
