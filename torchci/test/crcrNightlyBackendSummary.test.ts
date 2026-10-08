import { readFileSync } from "fs";
import path from "path";

const queryDir = path.resolve(
  __dirname,
  "..",
  "clickhouse_queries",
  "crcr_nightly_backend_summary"
);
const query = readFileSync(path.join(queryDir, "query.sql"), "utf8");
const params = JSON.parse(
  readFileSync(path.join(queryDir, "params.json"), "utf8")
);

describe("crcr_nightly_backend_summary", () => {
  test("retains complete runs and only their final job attempts", () => {
    expect(query).toContain("WITH eligible_runs AS");
    expect(query).toContain("AND run_id IN (SELECT run_id FROM eligible_runs)");
    expect(query).toContain("GROUP BY run_id, job_name");
    expect(query).toContain("max(run_attempt) AS max_attempt");
    expect(query).toContain("AND status = 'completed'");
  });

  test("reports distinct runs without grouping by upstream SHA", () => {
    expect(query).toContain("uniqExact(run_id) AS nightly_runs");
    expect(query).not.toContain("pytorch_head_sha");
  });

  test("treats expected CRCR probe outcomes as successes", () => {
    expect(query).toContain("LIKE '%xfail%'");
    expect(query).toContain("LIKE '%xcancel%'");
    expect(query).toContain("LIKE '%xtimeout%'");
  });

  test("accepts a repository and time range", () => {
    expect(params.params).toEqual({ repo: "String", days: "UInt64" });
  });
});
