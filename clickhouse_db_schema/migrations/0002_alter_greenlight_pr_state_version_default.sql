-- Safety-net DEFAULT for `version`; the writer MUST still pass an explicit monotonic
-- value. `version` is the ReplacingMergeTree collapse key (highest wins per PR) and the
-- land-guard evaluation time, so relying on the default would let concurrent writes
-- collapse to whichever the server timestamped last rather than the intended order.
-- Separate forward migration because 0001 is already applied and an applied migration
-- is never edited. `DATETIME64 (3)` is spelled upper/spaced because that is the
-- sqlfluff-canonical form inside ALTER ... MODIFY; ClickHouse matches type names
-- case-insensitively, so it is the same type as `DateTime64(3)` in 0001.
ALTER TABLE misc.greenlight_pr_state
MODIFY COLUMN `version` DATETIME64 (3) DEFAULT now64(3)
