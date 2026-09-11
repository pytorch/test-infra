-- Records the failing checks that the AI CI Advisor cleared, so the one
-- classification no human made is not the only one leaving no audit trail.
-- Written by save_merge_record in pytorch/pytorch#195503.
--
-- SEQUENCING. aws/lambda/clickhouse-replicator-s3 inserts positionally
-- (`select *, (bucket, key)`), so it supplies exactly as many values as the
-- table has columns. Running this ALTER on its own therefore breaks EVERY
-- merge insert on column count -- wherever the column is placed -- until that
-- lambda also declares it. The break is silent: the exception goes to
-- errors.gen_errors and the S3 objects are not reprocessed. So either
--   * land pytorch/test-infra#8716 first (it names the columns, after which
--     the table's column count stops mattering), or
--   * apply this ALTER and the matching merges_adapter schema change together.
--
-- `AFTER unstable_checks` in both cases: `_meta` stays the last column, which
-- is what the positional insert requires and what the rest of this directory
-- assumes.
--
-- Applied to the live table by hand -- see clickhouse_db_schema/README.md.
ALTER TABLE default.merges
ADD COLUMN IF NOT EXISTS `ai_not_related_checks` Array(Array(String))
AFTER `unstable_checks`
