CREATE TABLE
    misc.torchagent_feedback (
        `user` String,
        `session_id` String,
        `history_key` String,
        `feedback` Int8,
        `time_inserted` DateTime64 (0, 'UTC')
    ) ENGINE = SharedMergeTree ('/clickhouse/tables/{uuid}/{shard}', '{replica}')
PARTITION BY
    toYYYYMM (time_inserted)
ORDER BY
    (user, session_id, time_inserted) SETTINGS index_granularity = 8192