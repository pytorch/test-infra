import { queryClickhouseSaved } from "./clickhouse";
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
