-- Results of the PR review agent's targets evals (pytorch/ciforge scripts/pr_review_eval): one row per
-- target per review job, whether a finding raised the target and whether it was blocking.
--
-- Column order must match the schema string in
-- aws/lambda/clickhouse-replicator-s3/lambda_function.py: the replicator
-- inserts positionally, so a column added to one side shifts every later value.
CREATE TABLE misc.pr_review_eval_targets
(
    `schema_version` UInt16,
    `timestamp` DateTime64(3),
    `run_id` Int64,
    `run_attempt` Int32,
    `run_url` String,
    `trigger_event` LowCardinality(String),
    `dataset` LowCardinality(String),
    `dataset_sha` String,
    `ref_label` LowCardinality(String),
    `ref_sha` String,
    `model` LowCardinality(String),
    `case_id` String,
    `pr_number` Int64,
    `rep` UInt16,
    `job_status` LowCardinality(String),
    `target_id` LowCardinality(String),
    `target_type` LowCardinality(String),
    `labeler` LowCardinality(String),
    `found` Bool,
    `blocking` Bool,
    `severity` LowCardinality(String),
    `judge_reason` String,

    `_meta` Tuple(bucket String, key String),
    `_inserted_at` DateTime MATERIALIZED now()
)
ENGINE = SharedReplacingMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}', _inserted_at)
ORDER BY (dataset, run_id, run_attempt, ref_label, case_id, rep, target_id)
SETTINGS index_granularity = 8192
