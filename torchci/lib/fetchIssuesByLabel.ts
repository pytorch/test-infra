import getRocksetClient from "./rockset";
import rocksetVersions from "rockset/prodVersions.json";

import { IssueData } from "./types";

export default async function fetchIssuesByLabel(label: string): Promise<IssueData[]> {
    const rocksetClient = getRocksetClient();
    const query = await rocksetClient.queryLambdas.executeQueryLambda(
        "commons",
        "issue_query",
        rocksetVersions.issue_query,
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
