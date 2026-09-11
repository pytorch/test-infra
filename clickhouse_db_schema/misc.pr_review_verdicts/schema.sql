-- Telemetry for the hardened PR review in pytorch/ciforge. Two rows per review
-- attempt: `started` from the prepare job, then a terminal row from publish.
--
-- Column order must match the schema string in
-- aws/lambda/clickhouse-replicator-s3/lambda_function.py: the replicator
-- inserts positionally, so a column added to one side shifts every later value.
CREATE TABLE misc.pr_review_verdicts
(
    `schema_version` UInt16,
    `phase` LowCardinality(String),
    `harness` LowCardinality(String),
    `harness_version` String,
    `repo` LowCardinality(String),
    `pr_number` Int64,
    `head_sha` String,
    `base_sha` String,
    `is_fork` Bool,
    `trigger_event` LowCardinality(String),
    `trigger_label` String,
    `trigger_run_id` Int64,
    `review_run_id` Int64,
    `review_run_attempt` Int32,
    `prompt_hash` String,
    `trusted_sha` String,
    `timestamp` DateTime64(3),
    `status` LowCardinality(String),
    -- Null unless status = 'succeeded'; emitted as JSON null otherwise.
    `verdict` LowCardinality(Nullable(String)),

    -- Terminal-only from here to `model`; defaulted on the started row.
    -- Model-authored and attacker-influenced. Sanitized upstream, but treat as
    -- untrusted text on render.
    `summary` String,
    `findings_count` Int32,
    `findings_dropped` Int32,
    `failure_detail` String,
    `reasoning_uri` String,
    `duration_ms` Int64,
    `num_turns` Int32,
    `total_cost_usd` Float64,
    `input_tokens` Int64,
    `output_tokens` Int64,
    `cache_read_input_tokens` Int64,
    `cache_creation_input_tokens` Int64,
    `model` String,
    `extra` Map(String, String),

    `_meta` Tuple(bucket String, key String),
    `_inserted_at` DateTime MATERIALIZED now()
)
ENGINE = SharedMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')
ORDER BY (repo, pr_number, head_sha, review_run_id, review_run_attempt, phase)
SETTINGS index_granularity = 8192
