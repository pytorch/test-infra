-- Add the S3 provenance column the clickhouse-replicator-s3 ingestion path needs:
-- general_adapter inserts positionally (`SELECT *, (bucket, key) AS _meta`), so
-- `_meta` must be the last ordinary column, before the MATERIALIZED `_inserted_at`.
-- Applied manually to the live table by clee2000/huydhn (no automated migration).
ALTER TABLE misc.greenlight_pr_state
ADD COLUMN IF NOT EXISTS `_meta` Tuple(bucket String, key String) AFTER `version`
