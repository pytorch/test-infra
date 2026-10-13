-- noqa: disable=CP05,LT01
-- (sqlfluff would rewrite ClickHouse's mixed-case type names; keep them as ClickHouse spells them.)
-- Example migration 3 of 3: a rollup table and the materialized view that
-- feeds it from every new row of migrate_example_events.
-- Two statements, one change: migrate.py runs them in order, and drop removes
-- the view before the table.
CREATE TABLE migrate_example_daily
(
    -- The day the events fall on, from migrate_example_events.ts.
    `day` Date,
    -- As migrate_example_events.kind.
    `kind` LowCardinality(String),
    -- Number of events that day; SummingMergeTree adds up the partial rows.
    `events` UInt64,
    -- Sum of migrate_example_events.value that day.
    `total` UInt64
)
ENGINE = SummingMergeTree
ORDER BY (kind, day);

CREATE MATERIALIZED VIEW migrate_example_daily_mv TO migrate_example_daily AS
SELECT
    toDate(ts) AS day,
    kind,
    count() AS events,
    sum(value) AS total
FROM migrate_example_events
GROUP BY day, kind;
