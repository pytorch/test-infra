-- tests.all_test_runs_by_name: a lean, re-sorted copy of tests.all_test_runs
-- keyed by test identity, so "history of one test" queries are fast.
--
-- The parent is ORDER BY (job_id, ...), which suits per-job queries but
-- scatters one test's timeline, so a lookup like this takes minutes there
-- and milliseconds here:
--
--   SELECT * FROM tests.all_test_runs_by_name
--   WHERE file = '...' AND classname = '...' AND name = '...'
--     AND time_inserted > now() - INTERVAL 30 DAY
--
-- The two heavy columns are excluded: skipped message bodies and meta. To get
-- them, join back to the parent on job_id (its leading sort key), file,
-- classname, name, invoking_file, and time_inserted. This key isn't strictly
-- unique (the parent has rare duplicate rows), so use ANY LEFT JOIN or
-- LIMIT 1 BY to avoid fan-out. failure/error/rerun bodies are rare, hence
-- cheap, and are kept.
--
-- Incremental MV: fires on every insert into the append-only parent; existing
-- parent history is intentionally not copied. To retire the pipeline, DROP
-- the _mv FIRST, then the table.

CREATE TABLE tests.all_test_runs_by_name
(
    `file` LowCardinality(String),
    `classname` LowCardinality(String),
    `name` String,
    `invoking_file` LowCardinality(String),
    `time_inserted` DateTime64(9) CODEC(Delta(8), ZSTD(1)),
    `job_id` Int64 CODEC(Delta(8), ZSTD(1)),
    `workflow_id` Int64 CODEC(Delta(8), ZSTD(1)),
    `workflow_run_attempt` Int32,
    `status` LowCardinality(String),
    `result` String,
    `time` Float32,
    `duration` Float32,
    `line` Int64 CODEC(T64, ZSTD(1)),
    `failure_count` UInt32 CODEC(T64, ZSTD(1)),
    `error_count` UInt32 CODEC(T64, ZSTD(1)),
    `rerun_count` UInt32 CODEC(T64, ZSTD(1)),
    `skipped_count` UInt32 CODEC(T64, ZSTD(1)),
    -- body types must match the parent exactly; the *_count columns above
    -- stay so aggregations read 4 bytes/row instead of decompressing arrays
    `failure` Array(Tuple(message String, text String, type String)),
    `error` Array(Tuple(message String, text String, type String)),
    `rerun` Array(Tuple(message String, text String)),
    -- refines time windows inside the month-granular partitions
    INDEX by_time_inserted time_inserted TYPE minmax GRANULARITY 1,
    -- serves name-only lookups; name is 3rd in the sort key, off the prefix
    INDEX by_name name TYPE set(0) GRANULARITY 4
)
-- No TTL: this is the compact long-retention history (~0.5-0.8 TiB/year vs
-- ~3.2 for the parent, estimated 2026-08), and the parent can be TTL'd
-- independently. Add retention later with MODIFY TTL + ttl_only_drop_parts=1.
ENGINE = MergeTree
PARTITION BY toYYYYMM(time_inserted)
ORDER BY (file, classname, name, time_inserted);

CREATE MATERIALIZED VIEW tests.all_test_runs_by_name_mv
TO tests.all_test_runs_by_name
AS
SELECT
    file,
    classname,
    name,
    invoking_file,
    time_inserted,
    job_id,
    workflow_id,
    workflow_run_attempt,
    status,
    result,
    time,
    duration,
    line,
    -- recomputed: the parent's MATERIALIZED *_count columns aren't reliably
    -- present in the inserted block an MV sees; the arrays are
    toUInt32(length(failure)) AS failure_count,
    toUInt32(length(error)) AS error_count,
    toUInt32(length(rerun)) AS rerun_count,
    toUInt32(length(skipped)) AS skipped_count,
    failure,
    error,
    rerun
FROM tests.all_test_runs;
