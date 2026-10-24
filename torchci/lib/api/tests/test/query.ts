import { CI_DATABASE } from "lib/api/tests/database";
import {
  COMBINED_HEALTH_SQL,
  CONFIGURATION_COLUMNS_SQL,
  CONFIGURATION_JOINS_SQL,
  HEALTH_RESULT_COLUMNS_SQL,
  TEST_CATALOG_COLUMNS_SQL,
  TEST_RESULT_COLUMNS_SQL,
} from "lib/api/tests/shared-sql";

export function buildTestDetailQuery(id: string) {
  return {
    params: { test_id: id },
    sql: `
WITH catalog AS (
    SELECT
${TEST_CATALOG_COLUMNS_SQL}
    FROM ${CI_DATABASE}.tests AS test FINAL
    LEFT JOIN (
        SELECT repo, file, owners FROM ${CI_DATABASE}.owners FINAL
    ) AS owner ON owner.repo = test.repo AND owner.file = test.file
    WHERE test.id = {test_id: UInt64}
), combined_health AS (
    SELECT
        tests_id, environments_id, env_vars_id, window, ran_on,${COMBINED_HEALTH_SQL}
    FROM ${CI_DATABASE}.health
    WHERE tests_id = {test_id: UInt64}
    GROUP BY tests_id, environments_id, env_vars_id, window, ran_on
)
SELECT
${TEST_RESULT_COLUMNS_SQL}
    health.window AS window,
    health.ran_on AS ran_on,
    health.has_health AS has_health,
    health.refreshed_at AS refreshed_at,
    health.workflow_paths_combined AS workflow_paths_combined,
    ${HEALTH_RESULT_COLUMNS_SQL},
${CONFIGURATION_COLUMNS_SQL}
FROM catalog
LEFT JOIN combined_health AS health ON health.tests_id = catalog.tests_id
${CONFIGURATION_JOINS_SQL}
ORDER BY health.environments_id, health.env_vars_id,
    health.window, health.ran_on
SETTINGS optimize_aggregation_in_order = 1
`,
  };
}
