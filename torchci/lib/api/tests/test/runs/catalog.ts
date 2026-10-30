import {
  EnvironmentRow,
  EnvVarsRow,
  TestRow,
  toEnvironment,
  toEnvVars,
  toTest,
} from "lib/api/tests/mapping";
import { buildRunCatalogQuery } from "lib/api/tests/test/runs/catalog-query";
import { RunCatalogRecord, RunFields } from "lib/api/tests/test/runs/types";
import { queryClickhouse } from "lib/clickhouse";

export interface RunCatalogRow extends TestRow, EnvironmentRow, EnvVarsRow {
  requested_tests_id_string: string;
  environments_id_string: string;
  env_vars_id_string: string;
  owners: string[];
  has_test: number;
  has_environment: number;
  has_env_vars: number;
}

// A run's configuration: the catalog ids it carries, as decimal strings.
export type RunConfiguration = Pick<
  RunFields,
  "tests_id" | "environments_id" | "env_vars_id"
>;

export function configurationKey(run: RunConfiguration) {
  return JSON.stringify([run.tests_id, run.environments_id, run.env_vars_id]);
}

// One batched read of the catalogs for these configurations, a
// configuration named twice read once, keyed by configurationKey; nothing is
// asked for none. The bundle pages expand their runs with it and the grid
// (grid.ts) its lanes.
export async function lookupRunCatalog(
  configurations: readonly RunConfiguration[]
): Promise<{
  byConfiguration: Map<string, RunCatalogRow>;
  query_duration_ms: number;
}> {
  if (configurations.length === 0) {
    return { byConfiguration: new Map(), query_duration_ms: 0 };
  }
  const { sql, params } = buildRunCatalogQuery([...configurations]);
  const queryStartedAt = performance.now();
  const rows: RunCatalogRow[] = await queryClickhouse(
    sql,
    params,
    "api_run_catalog"
  );
  return {
    byConfiguration: new Map(
      rows.map((row) => [
        configurationKey({
          tests_id: row.requested_tests_id_string,
          environments_id: row.environments_id_string,
          env_vars_id: row.env_vars_id_string,
        }),
        row,
      ])
    ),
    query_duration_ms: Math.round(performance.now() - queryStartedAt),
  };
}

// The environment and env var set records of a catalog row: null for a
// catalog that has none, or for no row at all.
export function catalogRecords(
  row: RunCatalogRow | undefined
): Pick<RunCatalogRecord, "environment" | "env_vars"> {
  return {
    environment: row?.has_environment === 1 ? toEnvironment(row) : null,
    env_vars: row?.has_env_vars === 1 ? toEnvVars(row) : null,
  };
}

export async function expandRunCatalog(runs: RunFields[]): Promise<{
  runs: RunCatalogRecord[];
  query_duration_ms: number;
}> {
  // Expand only the returned page; catalog availability cannot change which
  // runs are selected, their order, or the cursor's position.
  const { byConfiguration, query_duration_ms } = await lookupRunCatalog(runs);
  return {
    runs: runs.map((run) => {
      const row = byConfiguration.get(configurationKey(run));
      const {
        tests_id: _testId,
        environments_id: _environmentId,
        env_vars_id: _envVarsId,
        ...fields
      } = run;
      return {
        ...fields,
        test: row?.has_test === 1 ? toTest(row) : null,
        ...catalogRecords(row),
        owners: row?.has_test === 1 ? row.owners : [],
      };
    }),
    query_duration_ms,
  };
}
