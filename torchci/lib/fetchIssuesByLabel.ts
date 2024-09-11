import rocksetVersions from "rockset/prodVersions.json";
import { queryClickhouseSaved } from "./clickhouse";
import getRocksetClient from "./rockset";
import { IssueData } from "./types";

export async function fetchIssuesByLabelCH(
  label: string
): Promise<IssueData[]> {
  // Uses CH and doesn't gate on env var, for use with Dr. CI
  return await queryClickhouseSaved("issue_query", {
    label,
  });
}

export default async function fetchIssuesByLabel(
  label: string
): Promise<IssueData[]> {
  const rocksetClient = getRocksetClient();
  const query = await rocksetClient.queryLambdas.executeQueryLambda(
    "commons",
    "issue_query",
    rocksetVersions.commons.issue_query,
    {
      parameters: [
        {
          name: "label",
          type: "string",
          value: label as string,
        },
      ],
    }
  );
  return query.results!;
}
