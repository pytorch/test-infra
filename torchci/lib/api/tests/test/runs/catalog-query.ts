import { CI_DATABASE } from "lib/api/tests/database";
import {
  CONFIGURATION_COLUMNS_SQL,
  TEST_CATALOG_COLUMNS_SQL,
  TEST_RESULT_COLUMNS_SQL,
} from "lib/api/tests/shared-sql";
import { RunFields } from "lib/api/tests/test/runs/types";

type RunConfiguration = Pick<
  RunFields,
  "tests_id" | "environments_id" | "env_vars_id"
>;

export function buildRunCatalogQuery(runs: RunConfiguration[]) {
  // The page is already limited. Deduplicate configurations, while keeping the
  // three parallel arrays aligned and their UInt64 IDs lossless.
  const configurations = Array.from(
    new Map(
      runs.map((run) => [
        `${run.tests_id}:${run.environments_id}:${run.env_vars_id}`,
        run,
      ])
    ).values()
  );
  return {
    params: {
      tests_ids: configurations.map((run) => run.tests_id),
      environments_ids: configurations.map((run) => run.environments_id),
      env_vars_ids: configurations.map((run) => run.env_vars_id),
    },
    sql: `
WITH configurations AS (
    SELECT
        configuration.1 AS tests_id,
        configuration.2 AS environments_id,
        configuration.3 AS env_vars_id
    FROM (
        SELECT arrayJoin(arrayZip(
            CAST({tests_ids: Array(String)}, 'Array(UInt64)'),
            CAST({environments_ids: Array(String)}, 'Array(UInt64)'),
            CAST({env_vars_ids: Array(String)}, 'Array(UInt64)')
        )) AS configuration
    )
), catalog AS (
    SELECT
${TEST_CATALOG_COLUMNS_SQL},
        toUInt8(1) AS has_test
    FROM ${CI_DATABASE}.tests AS test FINAL
    LEFT JOIN (
        SELECT repo, file, owners FROM ${CI_DATABASE}.owners FINAL
    ) AS owner ON owner.repo = test.repo AND owner.file = test.file
    WHERE test.id IN CAST({tests_ids: Array(String)}, 'Array(UInt64)')
)
SELECT
${TEST_RESULT_COLUMNS_SQL}
${CONFIGURATION_COLUMNS_SQL},
    toString(health.tests_id) AS requested_tests_id_string,
    catalog.has_test AS has_test,
    environment.has_environment AS has_environment,
    env_var_set.has_env_vars AS has_env_vars
-- The shared configuration projection calls its input health. Here its input
-- is the requested run configurations; no health-table lookup is needed.
FROM configurations AS health
LEFT JOIN catalog ON catalog.tests_id = health.tests_id
LEFT JOIN (
    SELECT id, os, os_version, cpu_architecture, cpu_capability, python_version,
        cc_compiler, cc_compiler_version, accelerator, accelerator_version,
        device_name, device_count, first_seen_at, toUInt8(1) AS has_environment
    FROM ${CI_DATABASE}.environments FINAL
    WHERE id IN CAST({environments_ids: Array(String)}, 'Array(UInt64)')
) AS environment ON environment.id = health.environments_id
LEFT JOIN (
    SELECT id, env_vars, first_seen_at, toUInt8(1) AS has_env_vars
    FROM ${CI_DATABASE}.env_vars FINAL
    WHERE id IN CAST({env_vars_ids: Array(String)}, 'Array(UInt64)')
) AS env_var_set ON env_var_set.id = health.env_vars_id
`,
  };
}
