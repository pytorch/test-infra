import getRocksetClient from "./rockset";
import rocksetVersions from "rockset/prodVersions.json";

import { FlakyTestData } from "./types";

export default async function fetchFlakyTests(numHours: string = "3",
  testName: string = "%", testSuite: string = "%", testFile: string = "%"): Promise<FlakyTestData[]> {
  const rocksetClient = getRocksetClient();
  const flakyTestQuery = await
    rocksetClient.queryLambdas.executeQueryLambda(
      "commons",
      "flaky_test_query",
      rocksetVersions.flaky_test_query,
      {
        parameters: [
          {
            name: "num_hours",
            type: "int",
            value: numHours,
          },
          {
            name: "name",
            type: "string",
            value: `%${testName}%`,
          },
          {
            name: "suite",
            type: "string",
            value: `%${testSuite}%`,
          },
          {
            name: "file",
            type: "string",
            value: `%${testFile}%`,
          },
        ],
      }
    );
  return flakyTestQuery.results ?? [];
}
