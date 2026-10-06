import { queryClickhouseSaved } from "./clickhouse";
import { CODE_SKIP_MIN_GREEN } from "./flakyBot/codeSkipUnskip";
import { PassingCodeSkipRow } from "./types";

export { CODE_SKIP_MIN_GREEN };

export default async function fetchPassingCodeSkips(): Promise<
  PassingCodeSkipRow[]
> {
  return await queryClickhouseSaved("flaky_tests/passing_code_skips", {
    min_num_green: CODE_SKIP_MIN_GREEN,
  });
}
