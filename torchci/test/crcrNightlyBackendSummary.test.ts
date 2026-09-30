import fs from "fs";
import { CRCR_TIME_RANGES } from "lib/crcr/timeRanges";
import path from "path";

const queryDir = path.resolve(
  __dirname,
  "..",
  "clickhouse_queries",
  "crcr_nightly_backend_summary"
);
const query = fs.readFileSync(path.join(queryDir, "query.sql"), "utf8");
const nightlySummaryQuery = fs.readFileSync(
  path.resolve(
    __dirname,
    "..",
    "clickhouse_queries",
    "crcr_nightly_summary",
    "query.sql"
  ),
  "utf8"
);
const successRateQuery = fs.readFileSync(
  path.resolve(
    __dirname,
    "..",
    "clickhouse_queries",
    "crcr_success_rate",
    "query.sql"
  ),
  "utf8"
);
const backendPage = fs.readFileSync(
  path.resolve(__dirname, "..", "pages", "crcr", "[org]", "[repo].tsx"),
  "utf8"
);
const crcrSummaryPage = fs.readFileSync(
  path.resolve(__dirname, "..", "pages", "crcr", "index.tsx"),
  "utf8"
);
const metricsPage = fs.readFileSync(
  path.resolve(__dirname, "..", "pages", "crcr", "metrics.tsx"),
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
    expect(query).toContain("uniqExact(run_id) AS nightly_runs");
  });

  test("counts CRCR's expected terminal outcomes as successes", () => {
    for (const canonicalQuery of [
      query,
      nightlySummaryQuery,
      successRateQuery,
    ]) {
      expect(canonicalQuery).toContain("LIKE '%xfail%'");
      expect(canonicalQuery).toContain("LIKE '%xcancel%'");
      expect(canonicalQuery).toContain("LIKE '%xtimeout%'");
    }
  });

  test("feeds the per-repo nightly card from the server-side summary", () => {
    expect(backendPage).toContain(
      "/api/clickhouse/crcr_nightly_backend_summary?parameters="
    );
    expect(backendPage).toContain("summaryStats={nightlySummary}");
    expect(backendPage).toContain('value={stats?.nightly_runs ?? "–"}');
  });

  test("keeps the per-repo CRCR view on its established seven-day default", () => {
    expect(backendPage).toContain(
      'const days = parseInt(router.query.days as string) || 7;'
    );
  });

  test("dates each trend run once after selecting its final attempts", () => {
    expect(successRateQuery).toContain(
      "GROUP BY downstream_repo, run_id, job_name"
    );
    expect(successRateQuery).toContain("toDate(max(started_at)) AS run_day");
    expect(successRateQuery).toContain(
      "INNER JOIN run_dates USING (downstream_repo, run_id)"
    );
  });

  test("shares one set of range options across CRCR views", () => {
    expect(CRCR_TIME_RANGES.map(({ days }) => days)).toEqual([
      1, 7, 14, 30, 90,
    ]);
    for (const page of [backendPage, crcrSummaryPage, metricsPage]) {
      expect(page).toContain("CRCR_TIME_RANGES.map");
    }
  });
});
