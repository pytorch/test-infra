import { queryClickhouseSaved } from "./clickhouse";
import { RecentWorkflowsData } from "./types";

export async function fetchRecentWorkflows(
  repo: string = "pytorch/pytorch",
  prNumber: string = "0",
  numMinutes: string = "30"
): Promise<RecentWorkflowsData[]> {
  const res = await queryClickhouseSaved("recent_pr_workflows_query", {
    numMinutes,
    prNumber,
    repo,
  });
  return res;
}

export async function fetchFailedJobsFromCommits(
  shas: string[]
): Promise<RecentWorkflowsData[]> {
  return await queryClickhouseSaved("commit_failed_jobs", {
    shas,
  });
}
