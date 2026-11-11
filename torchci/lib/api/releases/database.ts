// The ClickHouse database that holds the release portal tables, release_event and
// release_artifact_observation (DDL in clickhouse_db_schema/). Every release API
// query qualifies its tables with this database.
export const RELEASE_DATABASE = "misc";
