-- noqa: disable=CP05,LT01
-- (sqlfluff would rewrite ClickHouse's mixed-case type names; keep them as ClickHouse spells them.)
-- Example migration 1 of 3: the table the later files build on.
-- The files in this folder exercise migrate.py in the shared sandbox database
-- fortesting, which the folder is named after, so every name carries the
-- migrate_example_ prefix to stay clear of the other tables there. Names are
-- unqualified and resolve in the database migrate.py selects.
CREATE TABLE migrate_example_events
(
    -- When the event happened.
    `ts` DateTime,
    -- What kind of event: 'build', 'test', ...; free-form in this example.
    `kind` LowCardinality(String),
    -- A measurement attached to the event, e.g. a duration in seconds.
    `value` UInt32
)
ENGINE = MergeTree
ORDER BY (kind, ts);
