import getRocksetClient from "./rockset";
import rocksetVersions from "rockset/prodVersions.json";

import { DisabledNonFlakyTestData } from "./types";

export default async function fetchDisabledNonFlakyTests(): Promise<
  DisabledNonFlakyTestData[]
> {
  const rocksetClient = getRocksetClient();
  const nonFlakyTestQuery = await rocksetClient.queryLambdas.executeQueryLambda(
    "commons",
    "disabled_non_flaky_tests",
    rocksetVersions.commons.disabled_non_flaky_tests,
    {
      parameters: [],
    }
  );
  return nonFlakyTestQuery.results ?? [];
}
