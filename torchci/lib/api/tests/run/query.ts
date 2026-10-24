import { CI_DATABASE } from "lib/api/tests/database";
import { PAGE_COLUMNS } from "lib/api/tests/test/runs/query";

export function buildRunDetailQuery(runId: string) {
  return {
    params: { run_id: runId },
    // UUID is not indexed or part of the replacement key. Discover matching
    // primary-key prefixes with a narrow UUID scan, then read their current
    // runs with FINAL. Only the discovery may filter UUID in PREWHERE: a
    // replacement can change it, so the final UUID check follows deduplication.
    sql: `
WITH (
    SELECT groupArray((tests_id, environments_id, env_vars_id, started_at))
    FROM ${CI_DATABASE}.runs
    PREWHERE id = {run_id: UUID}
) AS matched_keys
SELECT ${PAGE_COLUMNS}
FROM ${CI_DATABASE}.runs AS run FINAL
PREWHERE (run.tests_id, run.environments_id, run.env_vars_id, run.started_at) IN (
    SELECT arrayJoin(matched_keys)
)
WHERE run.id = {run_id: UUID}
LIMIT 2
SETTINGS optimize_move_to_prewhere_if_final = 0
`,
  };
}
