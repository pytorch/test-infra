-- Per-minute insert outcomes for tables in the ci, tests and fortesting databases, from
-- system.query_log, so Grafana can chart TOO_MANY_PARTS rejections and delayed inserts
-- without system table grants.
--
-- Apply the table, then grants.sql, then the view (its DEFINER must exist first).
-- To change the query, recreate only the view: the table holds the history.
-- Force a refresh with:
--   SYSTEM REFRESH VIEW misc.clickhouse_insert_health_mv;
--   SYSTEM WAIT VIEW misc.clickhouse_insert_health_mv;
CREATE TABLE misc.clickhouse_insert_health
(
    `minute` DateTime,
    `table` LowCardinality(String),
    -- successful inserts
    `inserts` UInt64,
    -- TOO_MANY_PARTS (code 252)
    `rejected` UInt64,
    `failed_other` UInt64,
    -- inserts ClickHouse throttled (DelayedInserts), mostly for too many active parts
    `delayed` UInt64,
    `refreshed_at` DateTime
)
ENGINE = ReplacingMergeTree(refreshed_at)
ORDER BY (table, minute)
TTL minute + INTERVAL 365 DAY;

-- Every 5 minutes, recompute the last 15 whole minutes; read with FINAL.
-- An insert counts only if every table it touched is in ci, tests or fortesting (or is
-- the s3() source), and then toward each of those tables, including ones it only read:
-- an MV target (tests.all_test_runs_by_name) repeats its source's counts. Not counted:
-- inserts that touch another database (e.g. ci.health's refresh reads default.*),
-- refreshable views' temp tables, and inserts rejected before naming a table (e.g. too
-- many simultaneous queries).
CREATE MATERIALIZED VIEW misc.clickhouse_insert_health_mv
REFRESH EVERY 5 MINUTE APPEND
TO misc.clickhouse_insert_health
DEFINER = insert_health_definer SQL SECURITY DEFINER
AS
SELECT
    toStartOfMinute(event_time) AS minute,
    arrayJoin(arrayFilter(t -> NOT startsWith(t, '_table_function.'), tables)) AS table,
    countIf(type = 'QueryFinish') AS inserts,
    countIf(exception_code = 252) AS rejected,
    countIf(type != 'QueryFinish' AND exception_code != 252) AS failed_other,
    sum(ProfileEvents['DelayedInserts']) AS delayed,
    now() AS refreshed_at
FROM clusterAllReplicas('default', system.query_log)
WHERE event_date >= yesterday()
  -- a scalar subquery is computed once, so every replica gets the same window
  AND event_time >= (SELECT toStartOfMinute(now()) - INTERVAL 15 MINUTE)
  AND query_kind = 'Insert'
  AND type != 'QueryStart'
  -- not a replica's share of a distributed insert
  AND is_initial_query = 1
  AND arrayExists(t -> match(t, '^(ci|tests|fortesting)\\.[^.`]'), tables)
  AND arrayAll(
      t -> startsWith(t, '_table_function.') OR match(t, '^(ci|tests|fortesting)\\.[^.`]'),
      tables
  )
GROUP BY minute, table;
