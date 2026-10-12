-- noqa: disable=CP05,LT01
-- (sqlfluff would rewrite ClickHouse's mixed-case type names; keep them as ClickHouse spells them.)
-- Example migration 2 of 3: a schema change as an ALTER.
-- IF NOT EXISTS makes it safe to run twice, which migrate.py relies on: a file
-- that fails partway is re-run from its first statement.
ALTER TABLE migrate_example_events
ADD COLUMN IF NOT EXISTS `source` LowCardinality(String) DEFAULT ''
COMMENT 'Who reported the event, e.g. a workflow name; empty when unknown.';
