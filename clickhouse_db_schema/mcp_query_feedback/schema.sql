CREATE TABLE misc.mcp_query_feedback (
    `created_at` DateTime64(0, 'UTC'),
    `user_id` String,
    `session_id` String,
    `feedback` Int8
) ENGINE = SharedMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')
PARTITION BY toYYYYMM(created_at)
ORDER BY (user_id, session_id, created_at)
TTL toDate(created_at) + toIntervalYear(1)
SETTINGS index_granularity = 8192
