CREATE TABLE misc.autorevert_state
(
    `ts` DateTime DEFAULT now(),
    `repo` LowCardinality(String) DEFAULT 'pytorch/pytorch',
    `state` String,
    `dry_run` UInt8 DEFAULT 0,
    `workflows` Array(String),
    `lookback_hours` UInt16,
    `params` String DEFAULT ''
)
    ENGINE = SharedMergeTree
        PARTITION BY toYYYYMM(ts)
        ORDER BY (repo, ts)
        SETTINGS index_granularity = 8192;
