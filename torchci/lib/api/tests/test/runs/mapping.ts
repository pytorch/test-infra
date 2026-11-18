import { expandRunCatalog } from "lib/api/tests/test/runs/catalog";
import { runReport } from "lib/api/tests/test/runs/report";
import {
  RunFields,
  RunGroup,
  RunRecord,
  RunWorkflowFields,
} from "lib/api/tests/test/runs/types";
import { expandRunWorkflow } from "lib/api/tests/test/runs/workflow";

export interface RunGroupRow {
  [key: string]: unknown;
  tests_id_string: string;
  environments_id_string: string;
  env_vars_id_string: string;
  github_workflow_job_id_string: string;
}

export interface RunRow
  extends RunGroupRow,
    Omit<
      RunFields,
      "tests_id" | "environments_id" | "env_vars_id" | "github_workflow_job_id"
    > {}

export function runGroup(row: RunGroupRow): RunGroup {
  return {
    tests_id: row.tests_id_string,
    environments_id: row.environments_id_string,
    env_vars_id: row.env_vars_id_string,
    github_workflow_job_id: row.github_workflow_job_id_string,
  };
}

function groupKey(group: RunGroup) {
  return JSON.stringify([
    group.tests_id,
    group.environments_id,
    group.env_vars_id,
    group.github_workflow_job_id,
  ]);
}

function compareAttempts(left: RunRow, right: RunRow) {
  for (const field of ["started_at", "ended_at", "id"] as const) {
    if (left[field] !== right[field])
      return left[field] < right[field] ? -1 : 1;
  }
  return 0;
}

// The metadata bundles share, by bundle: the catalogs' records and the
// workflow's. It follows from a bundle's keys alone, so a page reads it
// alongside its attempts.
export interface RunMetadata {
  byGroup: Map<
    string,
    {
      catalog: Pick<RunRecord, "test" | "environment" | "env_vars" | "owners">;
      workflow: RunWorkflowFields;
    }
  >;
  query_duration_ms: number;
}

// The two lookups are independent.
export async function lookupRunMetadata(
  groups: readonly RunGroup[]
): Promise<RunMetadata> {
  const [expanded, withWorkflow] = await Promise.all([
    expandRunCatalog([...groups]),
    expandRunWorkflow(
      groups.map(({ github_workflow_job_id }) => ({ github_workflow_job_id }))
    ),
  ]);
  return {
    byGroup: new Map(
      groups.map((group, index) => [
        groupKey(group),
        { catalog: expanded.runs[index], workflow: withWorkflow.runs[index] },
      ])
    ),
    query_duration_ms:
      expanded.query_duration_ms + withWorkflow.query_duration_ms,
  };
}

// The bundles of the given attempts, in the order given or as they come,
// with their metadata: the one handed in, or read here for the bundles that
// have attempts.
export async function expandRunRows(
  rows: RunRow[],
  groupOrder?: readonly RunGroup[],
  metadata?: RunMetadata
): Promise<{ runs: RunRecord[]; query_duration_ms: number }> {
  // Group by stored foreign keys before catalog expansion: null metadata must
  // never collapse different tests, configurations or jobs into one bundle.
  const byGroup = new Map<string, RunRow[]>();
  for (const row of rows) {
    const key = groupKey(runGroup(row));
    const group = byGroup.get(key);
    if (group) group.push(row);
    else byGroup.set(key, [row]);
  }
  const groups = groupOrder
    ? groupOrder.flatMap((group) => {
        const attempts = byGroup.get(groupKey(group));
        return attempts ? [attempts] : [];
      })
    : Array.from(byGroup.values());
  for (const attempts of groups) attempts.sort(compareAttempts);
  const bundles = groups.map((attempts) => runGroup(attempts[0]));
  // Shared metadata is expanded once per selected bundle, and the page
  // order kept even if attempts arrived unordered.
  const { byGroup: metadataOf, query_duration_ms } =
    metadata ?? (await lookupRunMetadata(bundles));
  return {
    runs: groups.map((attempts, index) => {
      const bundle = bundles[index];
      const { catalog, workflow } = metadataOf.get(groupKey(bundle))!;
      return {
        test: catalog.test,
        environment: catalog.environment,
        env_vars: catalog.env_vars,
        owners: catalog.owners,
        github_workflow: {
          job_id: bundle.github_workflow_job_id,
          run_id: workflow.github_workflow_run_id,
          path: workflow.workflow_path,
          commit_sha: workflow.commit_sha,
          job_url: workflow.github_workflow_job_url,
          job_name: workflow.github_workflow_job_name,
          event: workflow.workflow_event,
          pull_request: workflow.workflow_pull_request,
        },
        attempts: attempts.map((row) => ({
          id: row.id,
          report: runReport(
            {
              test: catalog.test,
              github_workflow_job_id: bundle.github_workflow_job_id,
              report_uuid: row.report_uuid,
            },
            workflow
          ),
          rerun_number: row.rerun_number,
          outcome: row.outcome,
          outcome_summary: row.outcome_summary,
          started_at: row.started_at,
          ended_at: row.ended_at,
        })),
      };
    }),
    query_duration_ms,
  };
}
