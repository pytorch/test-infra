import type { ClickHouseSettings } from "@clickhouse/client";

// The ClickHouse database that holds the test hub tables: tests, environments,
// env_vars, owners, runs and health (DDL in clickhouse_db_schema/ci/).
// Every tests API query qualifies its tables with this database.
export const CI_DATABASE = "ci";

// What a heavy query sends: the ci_workload_heavy settings profile (DDL in
// clickhouse_db_schema/ci/000003-ci-workload-heavy.sql) runs it with at most
// 4 threads, 60 seconds and 8 GB of memory, two at a time per replica with a
// queue of 16 behind them; a refused query fails with SERVER_OVERLOADED, which
// failQuery in lib/api/handler.ts answers as 429. Pass it as the settings
// argument of queryClickhouse only where requests cost about ten CPU-seconds
// or more, never on a millisecond query, which the queue could only delay:
// the rule and the current list are in the Heavy queries section of
// app/api/README.md.
export const CI_WORKLOAD_HEAVY: ClickHouseSettings = {
  profile: "ci_workload_heavy",
};
