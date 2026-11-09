-- PyTorch Release Portal: the resolved release config, stored once per release and
-- updated when the config changes.
--
-- The config (release/portal/config) changes from release to release as steps are added,
-- removed or automated. A release's history has to keep showing the steps it was run
-- with, and the release index needs each release's branch and GA date, so the collector
-- stores the resolved config (shared base merged with the per-release file) here.
-- The latest row for a release is its current config:
--
--   SELECT release, argMax(resolved_config, updated_at) AS resolved_config
--   FROM misc.release_config_snapshot
--   GROUP BY release
CREATE TABLE misc.release_config_snapshot
(
    `release` LowCardinality(String),
    -- 'minor' or 'patch'.
    `release_type` LowCardinality(String),
    `branch` String,
    -- The planned GA date, NULL until one is set; `ga_planned` is 0 once the release is out.
    `ga_date` Nullable(Date),
    `ga_planned` UInt8 DEFAULT 1,
    -- The resolved config as JSON, as served by GET /api/releases/{version}/config.
    `resolved_config` String,
    -- Git sha of the config in test-infra the snapshot was resolved from.
    `config_sha` FixedString(40),
    `updated_at` DateTime64(3) DEFAULT now64(3),
    `_inserted_at` DateTime MATERIALIZED now()
)
ENGINE = SharedReplacingMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}', updated_at)
ORDER BY (release, config_sha)
SETTINGS index_granularity = 8192
