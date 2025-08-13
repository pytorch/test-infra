CREATE TABLE misc.autorevert_events
(
    `ts` DateTime DEFAULT now(),
    `repo` LowCardinality(String) DEFAULT 'pytorch/pytorch',
    `workflow` LowCardinality(String),
    `action` Enum8('detected' = 1, 'restart_dispatched' = 2, 'restart_skipped' = 3, 'restart_failed' = 4, 'secondary_confirmed' = 5),
    `first_failing_sha` FixedString(40),
    `previous_sha` FixedString(40),
    `second_failing_sha` Nullable(FixedString(40)) DEFAULT NULL,
    `failure_rule` LowCardinality(String),
    `job_name_base` String,
    `dry_run` UInt8 DEFAULT 0,
    `notes` String DEFAULT '',
    `version` UInt64 MATERIALIZED toUInt64(toUnixTimestamp(ts))
)
    ENGINE = SharedReplacingMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}', version)
        ORDER BY (repo, workflow, action, first_failing_sha, dry_run)
        SETTINGS index_granularity = 8192