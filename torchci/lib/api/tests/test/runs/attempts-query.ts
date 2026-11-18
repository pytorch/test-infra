import { CI_DATABASE } from "lib/api/tests/database";
import {
  classifiedRunsSource,
  PAGE_COLUMNS,
} from "lib/api/tests/test/runs/query";
import type { RunGroup } from "lib/api/tests/test/runs/types";

// The attempt columns a page returns besides its group keys.
const ATTEMPT_COLUMNS = [
  "id",
  "report_uuid",
  "rerun_number",
  "outcome",
  "outcome_summary",
  "started_at",
  "ended_at",
];

// The bundles, bound as four aligned arrays: with a parameter for each ID a
// hundred bundles made 29 KB of SQL in every membership test.
const BUNDLES = `(
            SELECT bundle.1, bundle.2, bundle.3, bundle.4
            FROM (
                SELECT arrayJoin(arrayZip(
                    CAST({tests_ids: Array(String)}, 'Array(UInt64)'),
                    CAST({environments_ids: Array(String)}, 'Array(UInt64)'),
                    CAST({env_vars_ids: Array(String)}, 'Array(UInt64)'),
                    CAST({github_workflow_job_ids: Array(String)}, 'Array(Int64)')
                )) AS bundle
            )
        )`;

const distinct = (ids: string[]) => new Set(ids).size;

export function buildRunAttemptsQuery(groups: readonly RunGroup[]) {
  // 64-bit IDs travel as strings, lossless.
  const params = {
    tests_ids: groups.map((group) => group.tests_id),
    environments_ids: groups.map((group) => group.environments_id),
    env_vars_ids: groups.map((group) => group.env_vars_id),
    github_workflow_job_ids: groups.map(
      (group) => group.github_workflow_job_id
    ),
  };
  // A commit's page holds many tests of few jobs, and its bundles' rows lie
  // together in the by_job projection, which the job and the test lead: read
  // as the pages read a scope's runs (classifiedRunsSource), by_job directly
  // and FINAL only at the starts with more than one stored row. identity()
  // keeps the main table's primary index out of that read; by_job's still
  // prunes by the IDs.
  // A test's page holds one test in many jobs, and its rows lie together in
  // the primary key: a plain read of the bundles finds the test,
  // configuration and start of every execution, and FINAL reads the granules
  // holding those starts, in their days' partitions.
  // Each read is the slower one on the other page: 0.09 s against 0.39 s for
  // a job's hundred bundles, 0.4 s and more against 0.06 s for a test's
  // (attempts-query-validation.md, 2026-11-16). Either way every stored
  // version of an execution shares its replacement key, so FINAL resolves it,
  // and there is no report, outcome, rerun-number, time-window or page
  // restriction on the returned attempts.
  const byJob =
    distinct(params.github_workflow_job_ids) < distinct(params.tests_ids);
  const membership = (key: (_column: string) => string) =>
    `(${key("tests_id")}, ${key("environments_id")}, ${key(
      "env_vars_id"
    )}, run.github_workflow_job_id) IN ${BUNDLES}`;
  const bundles = membership((column) => `run.${column}`);
  return {
    params,
    sql: `
SELECT ${PAGE_COLUMNS}
FROM ${
      byJob
        ? classifiedRunsSource(
            `WHERE ${membership((column) => `identity(run.${column})`)}`,
            ATTEMPT_COLUMNS
          )
        : `${CI_DATABASE}.runs AS run FINAL
PREWHERE (run.tests_id, run.environments_id, run.env_vars_id, run.started_at) IN (
    SELECT run.tests_id, run.environments_id, run.env_vars_id, run.started_at
    FROM ${CI_DATABASE}.runs AS run
    WHERE ${bundles}
)
WHERE ${bundles}`
    }
ORDER BY run.started_at ASC, run.ended_at ASC, toString(run.id) ASC
SETTINGS optimize_move_to_prewhere_if_final = 0
`,
  };
}
