import { readFileSync } from "fs";
import {
  CRCR_HEALTH_STALE_AFTER_MINUTES,
  CRCR_HEALTH_WINDOW_MINUTES,
  summarizeCrcrHealth,
} from "lib/crcr/healthProbe";
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
const latestJobs = query.slice(query.indexOf("latest_jobs AS"));
const normalizedQuery = query.replace(/\s+/g, " ");

describe("CRCR relay health probe", () => {
  test("limits PRs and jobs to a window that outlasts the sweep deadline", () => {
    expect(CRCR_HEALTH_WINDOW_MINUTES).toBeGreaterThan(
      CRCR_HEALTH_STALE_AFTER_MINUTES
    );
    expect(recentPrs).toContain(
      "started_at >= now() - INTERVAL {window_minutes: UInt64} MINUTE"
    );
    expect(latestJobs).toContain(
      "started_at >= now() - INTERVAL {window_minutes: UInt64} MINUTE"
    );
  });

  test("keeps expected in-progress probes out of pending and overdue counts", () => {
    expect(normalizedQuery).toContain(
      "countIf( status = 'in_progress' AND job_name NOT LIKE '%xfail%' AND job_name NOT LIKE '%xtimeout%' ) AS pending"
    );
    expect(normalizedQuery).toContain(
      "countIf( status = 'in_progress' AND job_name NOT LIKE '%xfail%' AND job_name NOT LIKE '%xtimeout%' AND started_at < now() - INTERVAL {stale_after_minutes: UInt64} MINUTE ) AS overdue_in_progress"
    );
  });

  test("stays healthy while ordinary probe jobs are pending", () => {
    expect(
      summarizeCrcrHealth([
        {
          total: 24,
          pass_rate: 1,
          pending: 1,
          overdue_in_progress: 0,
        },
      ])
    ).toMatchObject({ state: "healthy" });
  });

  test("stays healthy while only deliberate timeout probes await the sweeper", () => {
    expect(
      summarizeCrcrHealth([
        {
          total: 24,
          pass_rate: 1,
          pending: 0,
          overdue_in_progress: 0,
        },
      ])
    ).toMatchObject({ state: "healthy", passedCount: 1 });
  });

  test("degrades when an ordinary probe job remains overdue", () => {
    expect(
      summarizeCrcrHealth([
        {
          total: 24,
          pass_rate: 1,
          pending: 1,
          overdue_in_progress: 1,
        },
      ])
    ).toMatchObject({ state: "degraded", overdue: 1 });
  });
});
