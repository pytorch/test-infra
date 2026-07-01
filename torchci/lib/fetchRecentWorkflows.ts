import { queryClickhouse, queryClickhouseSaved } from "./clickhouse";
import { RecentWorkflowsData } from "./types";

export async function fetchRecentWorkflows(
  repo: string = "pytorch/pytorch",
  prNumbers: Array<number> = [],
  numMinutes: string = "30"
): Promise<RecentWorkflowsData[]> {
  return await queryClickhouseSaved("recent_pr_workflows_query", {
    numMinutes,
    prNumbers,
    repo,
  });
}

export async function fetchOotWorkflows(
  repo: string = "pytorch/pytorch",
  prNumbers: Array<number> = [],
): Promise<RecentWorkflowsData[]> {
  // Query the oot_workflow_job table for CRCR downstream CI jobs on open PRs.
  // Map columns to RecentWorkflowsData shape so Dr.CI can classify them.
  const rows = await queryClickhouse(
    `SELECT
      workflow_name AS name,
      job_name AS jobName,
      pr_number,
      check_run_id AS id,
      conclusion,
      started_at AS completed_at,
      workflow_run_url AS html_url,
      pytorch_head_sha AS head_sha,
      downstream_repo,
      downstream_repo_level
    FROM default.oot_workflow_job
    WHERE upstream_repo = {repo:String}
      AND pr_number IN ({prNumbers:Array(UInt64)})
      AND status = 'completed'
      AND conclusion IN ('failure', 'cancelled', 'timed_out')`,
    { repo, prNumbers: prNumbers.length > 0 ? prNumbers : [0] }
  );

  return rows.map((row: any) => ({
    name: `crcr/${row.downstream_repo}/${row.name}`,
    jobName: row.jobName || row.name,
    workflowId: 0,
    workflowUniqueId: 0,
    id: parseInt(row.id) || 0,
    completed_at: row.completed_at || "",
    html_url: row.html_url || "",
    head_sha: row.head_sha || "",
    head_sha_timestamp: "",
    head_branch: "",
    pr_number: parseInt(row.pr_number) || 0,
    conclusion: row.conclusion || "failure",
    failure_captures: [],
    failure_lines: [],
    failure_context: [row.downstream_repo_level || ""],
    // The downstream repo level ("L3"/"L4") is stashed in failure_context[0]
    // so the classification logic can access it without type changes.
  }));
}

export async function fetchFailedJobsFromCommits(
  shas: string[]
): Promise<RecentWorkflowsData[]> {
  return await queryClickhouseSaved("commit_failed_jobs", {
    shas,
  });
}

export async function fetchJobNamesFromCommits(
  shas: string[]
): Promise<{ head_sha: string; name: string }[]> {
  return await queryClickhouseSaved("commit_job_names", {
    shas,
  });
}
