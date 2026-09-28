import fs from "fs";
import path from "path";

const queryDir = path.resolve(
  __dirname,
  "..",
  "clickhouse_queries",
  "crcr_nightly_backend_summary"
);
const query = fs.readFileSync(path.join(queryDir, "query.sql"), "utf8");
const backendPage = fs.readFileSync(
  path.resolve(__dirname, "..", "pages", "crcr", "[org]", "[repo].tsx"),
  "utf8"
);

describe("crcr_nightly_backend_summary", () => {
  test("keeps complete runs and only their final job attempts", () => {
    expect(query).toContain("WITH eligible_runs AS");
    expect(query).toContain("AND run_id IN (SELECT run_id FROM eligible_runs)");
    expect(query).toContain("GROUP BY run_id, job_name");
    expect(query).toContain("max(run_attempt) AS max_attempt");
    expect(query).toContain("AND status = 'completed'");
  });

  test("does not collapse distinct runs that share a PyTorch SHA", () => {
    expect(query).not.toContain("pytorch_head_sha");
    expect(query).toContain("count() AS total");
  });

  test("counts CRCR's expected terminal outcomes as successes", () => {
    expect(query).toContain("job_name LIKE '%xfail%' AND conclusion = 'failure'");
    expect(query).toContain(
      "job_name LIKE '%xcancel%' AND conclusion = 'cancelled'"
    );
    expect(query).toContain(
      "job_name LIKE '%xtimeout%' AND conclusion = 'timed_out'"
    );
  });

  test("feeds the per-repo nightly card from the server-side summary", () => {
    expect(backendPage).toContain(
      "/api/clickhouse/crcr_nightly_backend_summary?parameters="
    );
    expect(backendPage).toContain("summaryStats={nightlySummary}");
  });
});
