-- NOT APPLIED to the live misc.greenlight_pr_state: `version` carries no default there.
-- Nothing depends on the default -- every writer passes `version` explicitly, which this
-- file already requires -- so the live table is correct without it. Confirm against
-- system.columns (database = 'misc', table = 'greenlight_pr_state', name = 'version')
-- rather than assuming any file in this directory reflects the live table.
--
-- Safety-net DEFAULT for `version`; the writer MUST still pass an explicit monotonic
-- value. `version` is the ReplacingMergeTree collapse key (highest wins per PR) and the
-- land-guard evaluation time, so relying on the default would let concurrent writes
-- collapse to whichever the server timestamped last rather than the intended order.
-- `DATETIME64 (3)` is spelled upper/spaced because that is the sqlfluff-canonical form
-- inside ALTER ... MODIFY; ClickHouse matches type names case-insensitively, so it is
-- the same type as the `DateTime64(3)` in 001.
ALTER TABLE misc.greenlight_pr_state
MODIFY COLUMN `version` DATETIME64 (3) DEFAULT now64(3)
