import getRocksetClient from "./rockset";

import { FlakyTestData } from "./types";

export default async function fetchFlakyTests(num_hours: string): Promise<FlakyTestData[]> {
  const rocksetClient = getRocksetClient();
  const flakyTestQuery = await
    rocksetClient.queryLambdas.executeQueryLambda(
      "commons",
      "flaky_test_query",
      "f9456c0b8c5a39a3",
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

   return flakyTestQuery.results ?? [];
}
