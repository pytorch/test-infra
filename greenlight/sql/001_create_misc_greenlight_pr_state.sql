-- NOTE: 004 supersedes the read guidance below. The sort key now ends in a
-- per-emit emit_id, so rows no longer collapse (the table is append-only); read
-- the authoritative latest row per PR with ORDER BY pr_number, run_id DESC,
-- version DESC LIMIT 1 BY pr_number -- NOT FINAL/argMax. The CREATE TABLE below
-- remains the base DDL applied to the live table.
--
-- That recipe selects the latest row, which is not the same as the latest row that carries
-- authority. A reader asking an authority question ("did greenlight approve this commit")
-- must ALSO filter shadow = false (005) in WHERE, ahead of the LIMIT 1 BY collapse: shadow
-- rows have to be gone before the collapse picks a winner, or a PR whose newest row is
-- shadow yields that row and then loses it instead of falling back to its newest
-- non-shadow row. Readers asking "was a review dispatched, at what run_id" stay unfiltered
-- (greenlight's own state.py does).
--
-- greenlight per-PR evaluation state, collapsed to one latest row per PR.
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
-- when they diverge (the PR moved since greenlight evaluated it).
CREATE TABLE IF NOT EXISTS misc.greenlight_pr_state
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
