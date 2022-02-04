import getRocksetClient from "./rockset";

import { FlakyTestData } from "./types";

export default async function fetchFlakyTests(num_hours: string): Promise<FlakyTestData[]> {
  const rocksetClient = getRocksetClient();
  const flakyTestQuery = await
    rocksetClient.queryLambdas.executeQueryLambda(
      "commons",
      "flaky_test_query",
      "d083df4d0817c423",
      {
        parameters: [
          {
            name: "num_hours",
            type: "int",
            value: num_hours,
          },
        ],
      }
    );

  const flaky_tests = flakyTestQuery.results;

  return flaky_tests.map<FlakyTestData>((flaky_test: any) => {
    return {
        file: flaky_test.file,
        suite: flaky_test.suite,
        name: flaky_test.name,
        num_green: flaky_test.num_green,
        num_red: flaky_test.num_red,
        workflow_ids: flaky_test.workflow_ids,
        workflow_names: flaky_test.workflow_names,
    }
  });
}
