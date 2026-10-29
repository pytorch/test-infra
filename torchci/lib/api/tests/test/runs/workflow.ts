import {
  GithubWorkflowSchema,
  RunFields,
  RunWorkflowFields,
} from "lib/api/tests/test/runs/types";
import { buildRunWorkflowQuery } from "lib/api/tests/test/runs/workflow-query";
import { queryClickhouse } from "lib/clickhouse";

interface RunWorkflowRow
  extends Omit<RunWorkflowFields, "workflow_pull_request"> {
  github_workflow_job_id: string;
  workflow_metadata_available: number;
  workflow_repository_id: string | null;
  workflow_pull_requests: unknown;
}

// SQL keeps its internal column names; validation follows the public object.
const WORKFLOW_FIELD_SCHEMAS = {
  github_workflow_run_id: GithubWorkflowSchema.shape.run_id,
  workflow_path: GithubWorkflowSchema.shape.path,
  commit_sha: GithubWorkflowSchema.shape.commit_sha,
  github_workflow_job_url: GithubWorkflowSchema.shape.job_url,
  github_workflow_job_name: GithubWorkflowSchema.shape.job_name,
  workflow_event: GithubWorkflowSchema.shape.event,
};

function workflowValue(
  row: RunWorkflowRow | undefined,
  field: keyof typeof WORKFLOW_FIELD_SCHEMAS
): string | null {
  const value = WORKFLOW_FIELD_SCHEMAS[field].safeParse(row?.[field] || null);
  return value.success ? value.data : null;
}

function workflowPullRequest(
  row: RunWorkflowRow | undefined
): RunWorkflowFields["workflow_pull_request"] {
  if (
    row?.workflow_metadata_available !== 1 ||
    !Array.isArray(row.workflow_pull_requests) ||
    typeof row.workflow_repository_id !== "string" ||
    !/^[1-9]\d{0,18}$/.test(row.workflow_repository_id)
  ) {
    return null;
  }
  const schema = GithubWorkflowSchema.shape.pull_request.unwrap();
  let pullRequest: RunWorkflowFields["workflow_pull_request"] = null;
  for (const raw of row.workflow_pull_requests) {
    // Match the destination repository by ID. Fork-sync PRs can use upstream
    // main as their source but target a different repository; exclude those.
    if (raw?.base_repository_id !== row.workflow_repository_id) continue;
    const parsed = schema.safeParse(raw);
    if (!parsed.success) continue;
    // GitHub records API URLs; preserve their repository when linking to the PR.
    const { number, url } = parsed.data;
    const match =
      /^https:\/\/api\.github\.com\/repos\/([^/?#]+)\/([^/?#]+)\/pulls\/([1-9]\d*)$/.exec(
        url
      );
    if (!match || match[3] !== String(number)) continue;
    // Within one repository the number identifies the PR. Collapse duplicates,
    // but do not choose an arbitrary PR when several distinct matches remain.
    if (pullRequest && pullRequest.number !== number) return null;
    pullRequest ??= {
      number,
      url: `https://github.com/${match[1]}/${match[2]}/pull/${number}`,
    };
  }
  return pullRequest;
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
        workflow_event: workflowValue(row, "workflow_event"),
        workflow_pull_request: workflowPullRequest(row),
      };
    }),
    query_duration_ms: queryDurationMs,
  };
}
