CREATE TABLE misc.claude_code_usage
(
    `repo` String,
    `run_id` Int64,
    `run_attempt` Int32,
    `actor` String,
    `event_name` String,
    `pr_number` Int64,
    `timestamp` DateTime64(3),
    `duration_ms` Int64,
    `num_turns` Int32,
    `total_cost_usd` Float64,
    `input_tokens` Int64 DEFAULT 0,
    `output_tokens` Int64 DEFAULT 0,
    `cache_read_input_tokens` Int64 DEFAULT 0,
    `cache_creation_input_tokens` Int64 DEFAULT 0,
    `model` String DEFAULT '',
    `_meta` Tuple(
        bucket String,
        key String),
    `_inserted_at` DateTime MATERIALIZED now()
)
ENGINE = SharedMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')
ORDER BY (repo, timestamp, run_id)
SETTINGS index_granularity = 8192
