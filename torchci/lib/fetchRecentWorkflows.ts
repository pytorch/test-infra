import getRocksetClient from "./rockset";
import rocksetVersions from "rockset/prodVersions.json";

import { RecentWorkflowsData } from "./types";

export default async function fetchRecentWorkflows(
  numMinutes: string = "30"
): Promise<RecentWorkflowsData[]> {
  const rocksetClient = getRocksetClient();
  const recentWorkflowsQuery = await rocksetClient.queryLambdas.executeQueryLambda(
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
      ],
    }
  );
  return recentWorkflowsQuery.results ?? [];
}
