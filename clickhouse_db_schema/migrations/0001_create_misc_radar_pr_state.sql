-- radar per-PR evaluation state, collapsed to one latest row per PR.
--
-- SharedReplacingMergeTree keyed on ORDER BY (repo, pr_number) keeps a single row
-- per PR. `version` is a monotonic write timestamp and is deliberately NOT part of
-- ORDER BY, so successive writes for the same PR collapse into one row and the
-- highest `version` wins (putting the timestamp in the sort key is the bug that
-- stops rows from collapsing).
--
-- Because collapse is asynchronous, reads must not trust a plain SELECT: use FINAL,
-- or argMax(col, version) grouped by (repo, pr_number), to observe the latest state.
--
-- `eval_hash` is the land-guard hash: pytorchbot recomputes the hash of the inputs
-- it is about to act on and compares it against the stored value, refusing to land
-- when they diverge (the PR moved since radar evaluated it).
CREATE TABLE IF NOT EXISTS misc.radar_pr_state
(
    `repo` LowCardinality(String),
    `pr_number` Int64,
    `head_sha` String,
    `status` LowCardinality(String),
    `reason` LowCardinality(String) DEFAULT '',
    `eval_hash` String,
    `message` String DEFAULT '',
    `eval_job` String DEFAULT '',
    `agent_job` String DEFAULT '',
    `version` DateTime64(3),
    `_inserted_at` DateTime MATERIALIZED now()
)
ENGINE = SharedReplacingMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}', version)
ORDER BY (repo, pr_number)
SETTINGS index_granularity = 8192
