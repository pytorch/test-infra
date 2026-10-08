import { readFileSync } from "fs";
import path from "path";

const query = readFileSync(
  path.resolve(
    __dirname,
    "..",
    "clickhouse_queries",
    "crcr_nightly_summary",
    "query.sql"
  ),
  "utf8"
);

describe("crcr_nightly_summary", () => {
  test("counts expected CRCR probe terminal outcomes as successes", () => {
    expect(query).toContain(
      "job_name LIKE '%xfail%' AND conclusion = 'failure'"
    );
    expect(query).toContain(
      "job_name LIKE '%xcancel%' AND conclusion = 'cancelled'"
    );
    expect(query).toContain(
      "job_name LIKE '%xtimeout%' AND conclusion = 'timed_out'"
    );
  });

  test("does not report expected failures and timeouts as regressions", () => {
    expect(query).toContain(
      "downstream_repo = 'pytorch/crcr-test'\n            AND job_name LIKE '%xfail%'"
    );
    expect(query).toContain(
      "downstream_repo = 'pytorch/crcr-test'\n            AND job_name LIKE '%xtimeout%'"
    );
  });
});
