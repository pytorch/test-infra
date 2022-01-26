import getRocksetClient from "./rockset";
import { PRData } from "./types";

export default async function fetchPR(
  repoOwner: string,
  repoName: string,
  prNumber: string
): Promise<PRData> {
  const rocksetClient = getRocksetClient();
  const [prQuery, commitHistoryQuery] = await Promise.all([
    rocksetClient.queryLambdas.executeQueryLambda(
      "commons",
      "pr_query",
      "8fe8d35745bba232",
      {
        parameters: [
          {
            name: "pr",
            type: "int",
            value: prNumber,
          },
          {
            name: "owner",
            type: "string",
            value: repoOwner,
          },
          {
            name: "repo",
            type: "string",
            value: repoName,
          },
        ],
      }
    ),
    rocksetClient.queryLambdas.executeQueryLambda(
      "commons",
      "pr_commit_history_query",
      "b36bd117e2cec4ea",
      {
        parameters: [
          {
            name: "pr",
            type: "int",
            value: prNumber,
          },
          {
            name: "owner",
            type: "string",
            value: repoOwner,
          },
          {
            name: "repo",
            type: "string",
            value: repoName,
          },
        ],
      }
    ),
  ]);
  const prDataResult = prQuery.results![0];

  return { ...prDataResult, shas: commitHistoryQuery.results! };
}
