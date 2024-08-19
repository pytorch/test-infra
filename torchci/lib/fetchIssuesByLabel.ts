import rocksetVersions from "rockset/prodVersions.json";
import { enableClickhouse, queryClickhouseSaved } from "./clickhouse";
import getRocksetClient from "./rockset";
import { IssueData } from "./types";

export default async function fetchIssuesByLabel(
  label: string,
  useClickhouse?: boolean
): Promise<IssueData[]> {
  if (useClickhouse === undefined) {
    useClickhouse = enableClickhouse();
  }

  if (!useClickhouse) {
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
  } else {
    return queryClickhouseSaved("issue_query", {
      label,
    }) as Promise<IssueData[]>;
  }
}
