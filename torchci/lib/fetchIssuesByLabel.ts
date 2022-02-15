import getRocksetClient from "./rockset";

import { IssueData } from "./types";

export default async function fetchIssuesByLabel(label: string): Promise<IssueData[]> {
    const rocksetClient = getRocksetClient();
    const query = await rocksetClient.queryLambdas.executeQueryLambdaByTag(
        "commons",
        "issue_query",
        "prod",
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
