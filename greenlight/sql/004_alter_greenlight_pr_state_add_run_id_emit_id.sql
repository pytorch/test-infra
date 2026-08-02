-- Hand-applied to the live misc.greenlight_pr_state by clee2000/huydhn; automated DDL is
-- disallowed. The engine stays SharedReplacingMergeTree(..., version); this is a
-- metadata-only ALTER, no data rewrite.
--
-- run_id (the dispatching workflow run id) and emit_id (a fresh UUID per emit) extend the
-- sort key. emit_id is unique per emit, so no two rows ever share the full key: nothing
-- collapses and every emit is retained (AI_REVIEW_STARTED markers included). The reader
-- selects the authoritative row per PR with ORDER BY pr_number, run_id DESC, version DESC
-- LIMIT 1 BY pr_number -- highest run_id, then latest version. run_id ahead of version is
-- race-proof: a superseded slower dispatch that finishes with a later version still loses
-- to the newer dispatch's higher run_id. Existing rows read run_id = 0, emit_id = '' from
-- the old parts, and being 1 row per PR today they still do not collapse.
--
-- This exact statement is load-bearing:
--   * ONE combined ALTER. MODIFY ORDER BY may only append columns introduced in the SAME
--     ALTER, so both ADD COLUMNs and the MODIFY ORDER BY must be one statement.
--   * NO DEFAULT on either column. ClickHouse rejects a column with a default expression in
--     the sorting key (even DEFAULT 0 / DEFAULT '' -- "Newly added column ... has a default
--     expression, so adding expressions that use it to the sorting key is forbidden").
--   * NO IF NOT EXISTS. A column that already exists OUTSIDE the sort key can never be
--     appended to it afterwards ("You can add expressions that use only the newly added
--     columns"); recovery is ALTER TABLE ... DROP COLUMN run_id, emit_id, then rerun this.
--
-- Three changes go live together, in lockstep:
--   1. this DDL;
--   2. the matching run_id + emit_id columns in greenlight_pr_state_adapter in
--      aws/lambda/clickhouse-replicator-s3/lambda_function.py -- the replicator inserts
--      positionally (SELECT *, (bucket, key) AS _meta), so a table/adapter column skew
--      shifts the insert and silently drops rows;
--   3. the greenlight service code, whose writer MUST always populate run_id and emit_id
--      and whose reader orders by run_id, so both columns must exist before it deploys.
-- A missing column fails the reader loud (a query error), never silently.
ALTER TABLE misc.greenlight_pr_state
    ADD COLUMN run_id Int64 AFTER version,
    ADD COLUMN emit_id String AFTER run_id,
    MODIFY ORDER BY (repo, pr_number, run_id, emit_id);
