CREATE TABLE misc.oss_ci_queue_time_histogram
(
    `created_time` DateTime64(0, 'UTC'),
    `histogram_version` String,
    `type` String,
    `repo` String,
    `time` DateTime64(0, 'UTC'),
    `workflow_name` String,
    `job_name` String,
    `machine_type` String,
    `histogram` Array(UInt64),
    `total_count` UInt64,
    `max_queue_time` UInt64,
    `avg_queue_time` UInt64,
    `runner_labels` Array(String),
    `extra_info` Map(String, String)
)
ENGINE = SharedMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')
PARTITION BY toYYYYMM(time)
ORDER BY (type, repo, time, machine_type, job_name, workflow_name)
TTL toDate(time) + toIntervalYear(5)
SETTINGS index_granularity = 8192
