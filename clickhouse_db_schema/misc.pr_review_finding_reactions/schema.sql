-- Emoji reactions on the PR review agent's inline findings. GitHub sends no webhook for reactions, so a
-- scheduled job reads them and writes one row per finding that has, or had, a reaction; the newest
-- `observed_at` wins. The finding's text is in default.pull_request_review_comment (join on comment_id).
--
-- Column order must match the schema string in
-- aws/lambda/clickhouse-replicator-s3/lambda_function.py: the replicator
-- inserts positionally, so a column added to one side shifts every later value.
CREATE TABLE misc.pr_review_finding_reactions
(
    `schema_version` UInt16,
    `observed_at` DateTime64(3),
    `repo` LowCardinality(String),
    `pr_number` Int64,
    `pr_author` String,
    `comment_id` Int64,
    `review_id` Int64,
    `comment_url` String,
    `path` String,
    `finding_created_at` DateTime64(3),
    `blocking` Bool,
    `thumbs_up` UInt32,
    `thumbs_down` UInt32,
    `other_reactions` UInt32,
    `reactors` Array(Tuple(login String, content LowCardinality(String), reacted_at DateTime64(3))),

    `_meta` Tuple(bucket String, key String),
    `_inserted_at` DateTime MATERIALIZED now()
)
ENGINE = SharedReplacingMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}', observed_at)
ORDER BY (repo, pr_number, comment_id)
SETTINGS index_granularity = 8192
