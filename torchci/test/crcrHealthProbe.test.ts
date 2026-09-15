import { readFileSync } from "fs";
import path from "path";

const query = readFileSync(
  path.resolve(
    __dirname,
    "..",
    "clickhouse_queries",
    "crcr_health_last_prs",
    "query.sql"
  ),
  "utf-8"
);

const recentPrs = query.slice(0, query.indexOf("latest_jobs AS"));

describe("CRCR relay health probe", () => {
  test("includes non-terminal probe PRs in the health window", () => {
    expect(recentPrs).not.toContain("status = 'completed'");
    expect(query).toContain("countIf(status = 'in_progress') AS in_progress");
  });

  test("marks jobs still in progress after the sweep deadline as overdue", () => {
    expect(query).toContain(
      "status = 'in_progress'\n" +
        "        AND started_at < now() - INTERVAL {stale_after_minutes: UInt64} MINUTE"
    );
    expect(query).toContain("AS overdue_in_progress");
  });
});
