import {
  GithubWorkflowSchema,
  RunFields,
  RunWorkflowFields,
} from "lib/api/tests/test/runs/types";
import { buildRunWorkflowQuery } from "lib/api/tests/test/runs/workflow-query";
import { queryClickhouse } from "lib/clickhouse";

interface RunWorkflowRow extends RunWorkflowFields {
  github_workflow_job_id: string;
}

// SQL keeps its internal column names; validation follows the public object.
const WORKFLOW_FIELD_SCHEMAS = {
  github_workflow_run_id: GithubWorkflowSchema.shape.run_id,
  workflow_path: GithubWorkflowSchema.shape.path,
  commit_sha: GithubWorkflowSchema.shape.commit_sha,
  github_workflow_job_url: GithubWorkflowSchema.shape.job_url,
  github_workflow_job_name: GithubWorkflowSchema.shape.job_name,
};

function workflowValue(
  row: RunWorkflowRow | undefined,
  field: keyof RunWorkflowFields
): string | null {
  const value = WORKFLOW_FIELD_SCHEMAS[field].safeParse(row?.[field] || null);
  return value.success ? value.data : null;
}

export async function expandRunWorkflow<
  T extends Pick<RunFields, "github_workflow_job_id">
>(
  runs: T[]
): Promise<{ runs: (T & RunWorkflowFields)[]; query_duration_ms: number }> {
  if (runs.length === 0) return { runs: [], query_duration_ms: 0 };

  const { sql, params } = buildRunWorkflowQuery(
    runs.map((run) => run.github_workflow_job_id)
  );
  const queryStartedAt = performance.now();
  const rows: RunWorkflowRow[] = await queryClickhouse(
    sql,
    params,
    "api_run_workflow"
  );
  const queryDurationMs = Math.round(performance.now() - queryStartedAt);
  const byJob = new Map(rows.map((row) => [row.github_workflow_job_id, row]));
  return {
    runs: runs.map((run) => {
      const row = byJob.get(run.github_workflow_job_id);
      return {
        ...run,
        github_workflow_run_id: workflowValue(row, "github_workflow_run_id"),
        workflow_path: workflowValue(row, "workflow_path"),
        commit_sha: workflowValue(row, "commit_sha"),
        github_workflow_job_url: workflowValue(row, "github_workflow_job_url"),
        github_workflow_job_name: workflowValue(
          row,
          "github_workflow_job_name"
        ),
      };
    }),
    query_duration_ms: queryDurationMs,
  };
}
