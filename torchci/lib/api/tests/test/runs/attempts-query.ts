import { CI_DATABASE } from "lib/api/tests/database";
import { PAGE_COLUMNS, RUN_GROUP_FIELDS } from "lib/api/tests/test/runs/query";
import type { RunGroup } from "lib/api/tests/test/runs/types";

export function buildRunAttemptsQuery(groups: readonly RunGroup[]) {
  const params: Record<string, unknown> = {};
  const values = groups.map((group, index) =>
    RUN_GROUP_FIELDS.map((field) => {
      const parameter = `group_${index}_${field}`;
      params[parameter] = group[field];
      return `{${parameter}: ${
        field === "github_workflow_job_id" ? "Int64" : "UInt64"
      }}`;
    })
  );
  const membership = `(${RUN_GROUP_FIELDS.map((field) => `run.${field}`).join(
    ", "
  )}) IN (${values.map((group) => `(${group.join(", ")})`).join(", ")})`;
  return {
    params,
    // A plain read of the bundles finds the test, configuration and start of
    // every execution they hold: the group columns lead the by_job
    // projection's key, so it reads only these jobs' rows, and every stored
    // version of an execution shares its replacement key. Those four columns
    // are the primary key, so FINAL then reads only the granules holding
    // these starts, in their days' partitions, instead of every configuration's
    // whole retained history: 2.2 million rows instead of 61 million for a
    // commit page of 100 bundles (attempts-query-validation.md, 2026-11-03).
    // They are replacement-key columns, so every version of a selected
    // execution stays eligible and FINAL resolves it as before; the full group
    // predicate then drops other jobs' executions at those starts. There is no
    // report, outcome, rerun-number, time-window or page restriction on the
    // returned attempts.
    sql: `
SELECT ${PAGE_COLUMNS}
FROM ${CI_DATABASE}.runs AS run FINAL
${
  values.length
    ? `PREWHERE (run.tests_id, run.environments_id, run.env_vars_id, run.started_at) IN (
    SELECT run.tests_id, run.environments_id, run.env_vars_id, run.started_at
    FROM ${CI_DATABASE}.runs AS run
    WHERE ${membership}
)
WHERE ${membership}`
    : "WHERE 0"
}
ORDER BY run.started_at ASC, run.ended_at ASC, toString(run.id) ASC
SETTINGS optimize_move_to_prewhere_if_final = 0
`,
  };
}
