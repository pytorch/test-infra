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

interface RunCatalogRow extends TestRow, EnvironmentRow, EnvVarsRow {
  requested_tests_id_string: string;
  environments_id_string: string;
  env_vars_id_string: string;
  owners: string[];
  has_test: number;
  has_environment: number;
  has_env_vars: number;
}

function configurationKey(
  run: Pick<RunFields, "tests_id" | "environments_id" | "env_vars_id">
) {
  return JSON.stringify([run.tests_id, run.environments_id, run.env_vars_id]);
}

export async function expandRunCatalog(runs: RunFields[]): Promise<{
  runs: RunCatalogRecord[];
  query_duration_ms: number;
}> {
  if (runs.length === 0) return { runs: [], query_duration_ms: 0 };

  // Expand only the returned page; catalog availability cannot change which
  // runs are selected, their order, or the cursor's position.
  const { sql, params } = buildRunCatalogQuery(runs);
  const queryStartedAt = performance.now();
  const rows: RunCatalogRow[] = await queryClickhouse(
    sql,
    params,
    "api_run_catalog"
  );
  const queryDurationMs = Math.round(performance.now() - queryStartedAt);
  const catalog = new Map(
    rows.map((row) => [
      configurationKey({
        tests_id: row.requested_tests_id_string,
        environments_id: row.environments_id_string,
        env_vars_id: row.env_vars_id_string,
      }),
      row,
    ])
  );
  return {
    runs: runs.map((run) => {
      const row = catalog.get(configurationKey(run));
      const {
        tests_id: _testId,
        environments_id: _environmentId,
        env_vars_id: _envVarsId,
        ...fields
      } = run;
      return {
        ...fields,
        test: row?.has_test === 1 ? toTest(row) : null,
        environment: row?.has_environment === 1 ? toEnvironment(row) : null,
        env_vars: row?.has_env_vars === 1 ? toEnvVars(row) : null,
        owners: row?.has_test === 1 ? row.owners : [],
      };
    }),
    query_duration_ms: queryDurationMs,
  };
}
