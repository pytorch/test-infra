import getRocksetClient from "./rockset";
import rocksetVersions from "rockset/prodVersions.json";

import { FlakyTestData } from "./types";

export default async function fetchFlakyTests(
  numHours: string = "3",
): Promise<FlakyTestData[]> {
  const rocksetClient = getRocksetClient();
  const flakyTestQuery = await rocksetClient.queryLambdas.executeQueryLambda(
    "commons",
    "flaky_tests",
    rocksetVersions.commons.flaky_tests,
    {
      parameters: [
        {
          name: "num_hours",
          type: "int",
          value: numHours,
        },
      ],
    }
  );
  return flakyTestQuery.results ?? [];
}

export async function fetchFlakyTestHistory(
  testName: string = "test_ddp_uneven_inputs",
  testSuite: string = "%",
  testFile: string = "%"
): Promise<FlakyTestData[]> {
  const rocksetClient = getRocksetClient();
  const flakyTestQuery = await rocksetClient.queryLambdas.executeQueryLambda(
    "commons",
    "flaky_test_history",
    rocksetVersions.commons.flaky_test_history,
    {
      parameters: [
        {
          name: "name",
          type: "string",
          value: `${testName}`,
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
