-- AI CI Advisor dispatch log.
--
-- Durable dedup + retry state for advisor workflow_dispatch runs, written
-- synchronously by HUD (both the manual "AI Analyze" button and the automatic
-- Dr.CI dispatch loop). Dedup is keyed on (owner, repo, head_sha, signal_key);
-- head_sha rotates on every push, so a changed PR re-analyzes automatically and
-- no TTL is needed.
--
-- Two writes per dispatch: 'dispatching' (pre-dispatch, also gates dispatch on
-- write-path health -- if we cannot record the marker we must not dispatch)
-- then 'dispatched' (post-dispatch). A 'failed' row supersedes the pre-dispatch
-- row when the dispatch call throws, re-enabling retry up to retry_count = MAX.
--
-- ReplacingMergeTree(version) keeps the latest-version row per ORDER BY key. The
-- version (a write timestamp) is deliberately NOT part of ORDER BY so the pre-
-- and post-dispatch rows for a single dispatch collapse into one row (putting
-- the timestamp in the sort key is the bug that stops misc.autorevert_events_v2
-- rows from collapsing).
CREATE TABLE misc.ai_advisor_dispatches
(
    `owner` LowCardinality(String),
    `repo` LowCardinality(String),
    `head_sha` FixedString(40),
    `signal_key` String,
    `state` Enum8('dispatching' = 1, 'dispatched' = 2, 'failed' = 3),
    `retry_count` UInt8 DEFAULT 0,
    `pr_number` Int64,
    `job_name` String,
    `version` DateTime64(3),
    `_inserted_at` DateTime MATERIALIZED now()
)
ENGINE = SharedReplacingMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}', version)
ORDER BY (owner, repo, head_sha, signal_key)
SETTINGS index_granularity = 8192
