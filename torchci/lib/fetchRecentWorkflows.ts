import rocksetVersions from "rockset/prodVersions.json";
import { enableClickhouse, queryClickhouseSaved } from "./clickhouse";
import getRocksetClient from "./rockset";
import { RecentWorkflowsData } from "./types";

export async function fetchRecentWorkflows(
  repo: string = "pytorch/pytorch",
  prNumber: string = "0",
  numMinutes: string = "30"
): Promise<RecentWorkflowsData[]> {
  if (enableClickhouse()) {
    const res = await queryClickhouseSaved("recent_pr_workflows_query", {
      numMinutes,
      prNumber,
      repo,
    });
    for (const row of res) {
      // Check for time 0 since CH uses default value
      if (row["head_sha_timestamp"] == "1970-01-01 00:00:00.000000000") {
        row["head_sha_timestamp"] = null;
      }
      if (row["completed_at"] == "1970-01-01 00:00:00.000000000") {
        row["completed_at"] = null;
      }
    }
    return res;
  }
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
  if (enableClickhouse()) {
    return await queryClickhouseSaved("commit_failed_jobs", {
      shas,
    });
  }
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
