import { queryClickhouseSaved } from "./clickhouse";
import { DisabledNonFlakyTestData } from "./types";

export default async function fetchDisabledNonFlakyTests(): Promise<
  DisabledNonFlakyTestData[]
> {
  return await queryClickhouseSaved("flaky_tests/disabled_non_flaky_tests", {
    max_num_red: 0,
    min_num_green: 150,
  });
}
