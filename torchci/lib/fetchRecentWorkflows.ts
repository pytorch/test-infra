import getRocksetClient from "./rockset";
import rocksetVersions from "rockset/prodVersions";

import { RecentWorkflowsData } from "./types";

export default async function fetchRecentWorkflows(
  numMinutes: string = "15"
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
