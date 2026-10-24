// The ClickHouse database that holds the test hub tables: tests, environments,
// env_vars, owners, runs and health (DDL in clickhouse_db_schema/ci/).
// Every tests API query qualifies its tables with this database.
export const CI_DATABASE = "ci";
