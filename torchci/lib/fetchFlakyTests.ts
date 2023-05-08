import getRocksetClient from "./rockset";
import rocksetVersions from "rockset/prodVersions.json";

import { FlakyTestData } from "./types";

export default async function fetchFlakyTests(
  numHours: string = "3",
  testName: string = "%",
  testSuite: string = "%",
  testFile: string = "%"
): Promise<FlakyTestData[]> {
  const rocksetClient = getRocksetClient();
  const flakyTestQuery = await rocksetClient.queryLambdas.executeQueryLambda(
    "commons",
    "flaky_tests",
    rocksetVersions.commons.flaky_tests,
    {
      parameters: [
        {
          name: "numHours",
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

export async function fetchFlakyTestsAcrossJobs(
  numHours: string = "3",
  threshold: number = 1,
  ignoreMessages: string = "No CUDA GPUs are available"
): Promise<FlakyTestData[]> {
  const rocksetClient = getRocksetClient();
  const flakyTestQuery = await rocksetClient.queryLambdas.executeQueryLambda(
    "commons",
    "flaky_tests_across_jobs",
    rocksetVersions.commons.flaky_tests_across_jobs,
    {
      parameters: [
        {
          name: "numHours",
          type: "int",
          value: numHours,
        },
        {
          name: "threshold",
          type: "int",
          value: threshold.toString(),
        },
        {
          name: "ignoreMessages",
          type: "string",
          value: ignoreMessages,
        },
      ],
    }
  );
  return flakyTestQuery.results ?? [];
}
