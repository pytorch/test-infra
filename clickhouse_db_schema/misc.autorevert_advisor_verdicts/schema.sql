CREATE TABLE misc.autorevert_advisor_verdicts
(
    `repo` LowCardinality(String),
    `run_id` Int64,
    `run_attempt` Int32,
    `timestamp` DateTime64(3),
    `suspect_commit` FixedString(40),
    `pr_number` Int64,
    `signal_key` String,
    `signal_source` LowCardinality(String),
    `workflow_name` String,
    `verdict` Enum8('revert' = 1, 'unsure' = 2, 'not_related' = 3, 'garbage' = 4),
    `confidence` Float32,
    `summary` String,
    `causal_reasoning` String,
    `_meta` Tuple(bucket String, key String),
    `_inserted_at` DateTime MATERIALIZED now()
)
ENGINE = SharedMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')
ORDER BY (repo, suspect_commit, signal_key, timestamp)
SETTINGS index_granularity = 8192
