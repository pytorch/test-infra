-- Point-in-time counts of self-hosted runners registered with a GitHub org,
-- bucketed by runner label. One row per (sample, label). Populated by the S3
-- replicator (clickhouse-replicator-s3): the runner-fleet-metrics workflow
-- uploads gzipped JSONEachRow to s3://gha-artifacts/runner_fleet_count/..., the
-- replicator does `INSERT INTO misc.runner_fleet_count SELECT *, (bucket, key)
-- AS _meta FROM s3(...)`. Graphed in Grafana via the ClickHouse datasource.
--
-- IMPORTANT: the general_adapter insert is positional (`SELECT *, _meta`), so
-- the column order here MUST match the adapter's schema string exactly, with
-- `_meta` last. Do not add DEFAULT/normal columns in between -- they would
-- shift the positional mapping and break ingestion.
CREATE TABLE misc.runner_fleet_count
(
    `time_stamp` DateTime64(0, 'UTC'),   -- when the fleet was sampled (UTC)
    `org` String,                        -- e.g. pytorch
    `label` String,                      -- e.g. linux.dgx.b200, macos-m1-stable
    `total_count` UInt32,                -- runners carrying this label
    `online_count` UInt32,               -- subset with status = online
    `busy_count` UInt32,                 -- subset currently running a job
    `_meta` Tuple(bucket String, key String)  -- S3 provenance added by replicator
)
ENGINE = SharedMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')
PARTITION BY toYYYYMM(time_stamp)
ORDER BY (label, org, time_stamp)
TTL toDate(time_stamp) + toIntervalYear(2)
SETTINGS index_granularity = 8192
