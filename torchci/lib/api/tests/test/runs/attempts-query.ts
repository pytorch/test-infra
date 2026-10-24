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
  const groupColumns = RUN_GROUP_FIELDS.map((field) => `run.${field}`);
  const membership = (length: number) =>
    `(${groupColumns.slice(0, length).join(", ")}) IN (${values
      .map((group) => `(${group.slice(0, length).join(", ")})`)
      .join(", ")})`;
  return {
    params,
    // The first three group columns are the primary-key prefix. Filtering
    // them before FINAL keeps every version of each selected execution; the
    // full group predicate also selects the job. There is no report, outcome,
    // rerun-number, timestamp or page restriction on the returned attempts.
    sql: `
SELECT ${PAGE_COLUMNS}
FROM ${CI_DATABASE}.runs AS run FINAL
${
  values.length
    ? `PREWHERE ${membership(3)}\nWHERE ${membership(4)}`
    : "WHERE 0"
}
ORDER BY run.started_at ASC, run.ended_at ASC, toString(run.id) ASC
SETTINGS optimize_move_to_prewhere_if_final = 0
`,
  };
}
