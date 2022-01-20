import getRocksetClient from "./rockset";
import { PRData } from "./types";

export default async function fetchPR(pr: string): Promise<PRData> {
  const rocksetClient = getRocksetClient();
  const [prQuery, commitHistoryQuery] = await Promise.all([
    rocksetClient.queryLambdas.executeQueryLambda(
      "commons",
      "pr_query",
      "70a7732df6e82401",
      {
        parameters: [
          {
            name: "pr",
            type: "int",
            value: pr,
          },
        ],
      }
    ),
    rocksetClient.queryLambdas.executeQueryLambda(
      "commons",
      "pr_commit_history_query",
      "03dcb4ad66c079f9",
      {
        parameters: [
          {
            name: "pr",
            type: "int",
            value: pr,
          },
        ],
      }
    ),
  ]);
  const prDataResult = prQuery.results![0];

  return { ...prDataResult, shas: commitHistoryQuery.results! };
}
