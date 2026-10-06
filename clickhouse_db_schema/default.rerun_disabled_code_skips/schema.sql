-- Code skips observed while rerunning disabled tests. One gzipped JSON object
-- per workflow attempt is uploaded to
-- s3://ossci-raw-job-status/rerun_disabled_code_skips/{workflow_id}/{attempt}
-- and copied here by clickhouse-replicator-s3.
--
-- The insert is positional (`SELECT *, _meta`), so this column order must match
-- rerun_disabled_code_skips_adapter exactly, with `_meta` last.
--
-- Do not add these columns to default.rerun_disabled_tests. That table is read
-- with a fixed column list.
--
-- Applied by hand. See clickhouse_db_schema/README.md.
CREATE TABLE default.rerun_disabled_code_skips
(
    `workflow_id` Int64,
    `workflow_run_attempt` Int64,
    `name` String,
    `classname` String,
    `filename` String,
    `num_green` Int64,
    `num_red` Int64,
    `code_skip` String,
    `_meta` Tuple(bucket String, key String)
)
ENGINE = SharedMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')
ORDER BY (workflow_id, workflow_run_attempt, name, classname, filename)
SETTINGS index_granularity = 8192
