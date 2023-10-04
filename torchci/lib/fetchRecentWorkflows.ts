import getRocksetClient from "./rockset";
import rocksetVersions from "rockset/prodVersions.json";

import { RecentWorkflowsData } from "./types";
import { removeCancelledJobAfterRetry } from "./jobUtils";

export async function fetchRecentWorkflows(
  repo: string = "pytorch/pytorch",
  prNumber: string = "0",
  numMinutes: string = "30"
): Promise<RecentWorkflowsData[]> {
  const rocksetClient = getRocksetClient();
  const recentWorkflowsQuery =
    await rocksetClient.queryLambdas.executeQueryLambda(
      "commons",
      "recent_pr_workflows_query",
      rocksetVersions.commons.recent_pr_workflows_query,
      {
        parameters: [
          {
            name: "numMinutes",
            type: "int",
            value: numMinutes,
          },
          {
            name: "prNumber",
            type: "int",
            value: prNumber,
          },
          {
            name: "repo",
            type: "string",
            value: repo,
          },
        ],
      }
    );
  return recentWorkflowsQuery.results ?? [];
}

export async function fetchFailedJobsFromCommits(
  shas: string[]
): Promise<RecentWorkflowsData[]> {
  const rocksetClient = getRocksetClient();
  const commitFailedJobsQuery =
    await rocksetClient.queryLambdas.executeQueryLambda(
      "commons",
      "commit_failed_jobs",
      rocksetVersions.commons.commit_failed_jobs,
      {
        parameters: [
          {
            name: "shas",
            type: "string",
            value: shas.join(","),
          },
        ],
      }
    );
  return commitFailedJobsQuery.results ?? [];
}
