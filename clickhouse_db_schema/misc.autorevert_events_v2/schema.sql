CREATE TABLE misc.autorevert_events_v2
(
    `ts` DateTime DEFAULT now(),
    `repo` LowCardinality(String) DEFAULT 'pytorch/pytorch',
    `action` Enum8('none' = 0, 'restart' = 1, 'revert' = 2),
    `commit_sha` FixedString(40),
    `workflows` Array(String),
    `source_signal_keys` Array(String),
    `dry_run` UInt8 DEFAULT 0,
    `failed` UInt8 DEFAULT 0,
    `notes` String DEFAULT ''
)
    ENGINE = SharedReplacingMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')
        PARTITION BY toYYYYMM(ts)
        ORDER BY (repo, commit_sha, action, ts)
        SETTINGS index_granularity = 8192;
