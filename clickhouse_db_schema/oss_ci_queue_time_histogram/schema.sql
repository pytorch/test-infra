CREATE TABLE misc.oss_ci_query_histogram(
    `type` String,
    `created_at` DateTime64(0,'UTC'),
    `time_stamp` DateTime64(0,'UTC'),
    `repo` String DEFAULT 'pytorch/pytorch',
    `workflow_id` UInt64,
    `run_attempt` UInt32,
    `job_id` UInt64,
    `workflow_name` String,
    `job_name` String,
    `machine_type` String,
    `data_version` String,
    `histogram` Array(UInt64),
    `max_queue_time` UInt64,
)ENGINE = SharedMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')
PARTITION BY toYYYYMM(created_at)
ORDER BY
    (
        workflow_id,
        job_id,
        repo,
        workflow_name,
        job_name,
        machine_type,
        time_stamp,
    )
-- data exists in the db for a year.
TTL toDate(time_stamp) + toIntervalYear(2)
SETTINGS index_granularity = 8192
