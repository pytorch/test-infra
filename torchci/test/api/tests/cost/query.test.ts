// The cost SQL against the rollup it reads, ci.test_cost
// (clickhouse_db_schema/ci/000004-test-cost-table.sql): every query reads
// that table through CI_DATABASE, only columns its DDL defines, each day as
// last computed, and sums the two triggers together, setting the push:main
// part aside for cost per commit; the pushes to main come from default.push. Whether the SQL returns the right rows is measured against
// the database in query-validation.md; these keep the text from drifting
// from the table it was measured on.

import { readFileSync } from "fs";
import { casesGateQuery } from "lib/api/tests/cost/cases";
import { decodeTrail } from "lib/api/tests/cost/contracts";
import {
  coverageOwnedQuery,
  coverageTestsQuery,
} from "lib/api/tests/cost/coverage";
import { ownersDaysQuery, ownersQuery } from "lib/api/tests/cost/owners";
import {
  coverageQuery,
  FILLING_HOURS,
  runnerHoursQuery,
  TEST_COST,
  trendDailyQuery,
  trendPushesQuery,
  trendQuery,
} from "lib/api/tests/cost/query";
import { scopeDaysQuery, scopeQuery } from "lib/api/tests/cost/scope";
import { TREND_ROLLUPS } from "lib/api/tests/cost/windows";
import { CI_DATABASE } from "lib/api/tests/database";
import { join } from "path";

const DDL = readFileSync(
  join(
    __dirname,
    "../../../../../clickhouse_db_schema/ci/000004-test-cost-table.sql"
  ),
  "utf8"
);
// The table's columns, as the DDL names them in backticks.
const COLUMNS = new Set(
  Array.from(
    DDL.slice(DDL.indexOf("CREATE TABLE")).matchAll(/^\s+`(\w+)`/gm),
    (m) => m[1]
  )
);
// Its sort key, whose leading (repo, day) every read filters on.
const SORT_KEY = DDL.slice(DDL.indexOf("ORDER BY"))
  .match(/\(([\s\S]*?)\)/)![1]
  .split(",")
  .map((c) => c.trim());

// Every query that reads the rollup, by name.
const READERS: Record<string, string> = {
  runnerHours: runnerHoursQuery(),
  coverage: coverageQuery(),
  ...Object.fromEntries(
    TREND_ROLLUPS.map((r) => [`trend ${r}`, trendQuery(r)])
  ),
  trendDaily: trendDailyQuery(),
  // The drill, its bars, the banner and the cases gate.
  "scope root": scopeQuery("sides", [], "o"),
  "scope pair files": scopeQuery(
    "sides",
    decodeTrail("o:inductor;m:Linux%20x86_64%20avx512"),
    "f"
  ),
  "series machines": scopeQuery("days", decodeTrail("o:inductor"), "m"),
  "series lanes": scopeQuery(
    "days",
    decodeTrail("o:inductor;m:NVIDIA%20L4;f:test%2Ftest_ops.py"),
    "lane"
  ),
  scopeDays: scopeDaysQuery("sides"),
  seriesDays: scopeDaysQuery("days"),
  coverageTests: coverageTestsQuery(),
  coverageOwned: coverageOwnedQuery(),
  casesGate: casesGateQuery(),
  // The owner bars.
  owners: ownersQuery(false),
  ownersByDay: ownersQuery(true),
  ownersDays: ownersDaysQuery(),
};

// The columns of test_cost the queries read, by name.
const READ = [
  "day",
  "repo",
  "workflow_path",
  "test_file",
  "environments_id",
  "runner_labels",
  "trigger",
  "occupancy_runner_milliseconds",
  "computed_at",
];

describe("the rollup the cost queries read", () => {
  test("is ci.test_cost, named through CI_DATABASE, in every query; none reads the sandbox", () => {
    expect(TEST_COST).toBe(`${CI_DATABASE}.test_cost`);
    expect(TEST_COST).toBe("ci.test_cost");
    for (const [name, sql] of Object.entries(READERS)) {
      expect([name, sql.includes("FROM ci.test_cost")]).toEqual([name, true]);
      expect([name, sql.includes("fortesting")]).toEqual([name, false]);
    }
  });

  test("its DDL defines every column the queries read, the trigger among them, and sorts by (repo, day) first", () => {
    expect(COLUMNS).toEqual(
      new Set([
        "day",
        "repo",
        "workflow_path",
        "test_file",
        "test_module",
        "environments_id",
        "runner_labels",
        "trigger",
        "owners",
        "executed_test_milliseconds",
        "skipped_test_milliseconds",
        "held_milliseconds",
        "occupancy_runner_milliseconds",
        "test_ratio_runner_milliseconds",
        "computed_at",
      ])
    );
    for (const column of READ) expect(COLUMNS.has(column)).toBe(true);
    expect(SORT_KEY.slice(0, 2)).toEqual(["repo", "day"]);
    expect(SORT_KEY).toContain("trigger");
    expect(DDL).toMatch(/trigger` Enum8\('push:main' = 1, 'other' = 2\)/);
    // Every column a query names that is one of some test_cost's is this
    // one's: a renamed column fails here, not in production.
    const anyRollupColumn =
      /\b(\w+_milliseconds|computed_at|runner_labels|workflow_path|test_file|test_module|environments_id|trigger)\b/g;
    for (const [name, sql] of Object.entries(READERS)) {
      for (const [column] of sql.matchAll(anyRollupColumn)) {
        expect([name, column, COLUMNS.has(column)]).toEqual([
          name,
          column,
          true,
        ]);
      }
    }
  });

  test("each read filters on the repository and its days, the sort key's prefix", () => {
    for (const [name, sql] of Object.entries(READERS)) {
      expect([name, sql]).toEqual([
        name,
        expect.stringContaining("repo = {repo: String}"),
      ]);
      expect([name, /\bday (>=|BETWEEN)/.test(sql)]).toEqual([name, true]);
    }
  });
});

describe("each day as last computed", () => {
  test("every query summing runner-hours reads each day's latest computation", () => {
    expect(runnerHoursQuery()).toContain(
      "max(computed_at) OVER (PARTITION BY day)"
    );
    for (const sql of [
      ...TREND_ROLLUPS.map(trendQuery),
      trendDailyQuery(),
      scopeQuery("sides", [], "o"),
      scopeQuery("days", decodeTrail("m:NVIDIA%20L4"), "o"),
      coverageTestsQuery(),
      coverageOwnedQuery(),
      casesGateQuery(),
      ownersQuery(false),
      ownersQuery(true),
    ]) {
      expect(sql).toContain("(day, computed_at) IN (");
      expect(sql).toContain("SELECT day, max(computed_at) FROM ci.test_cost");
    }
  });

  test("a day is filling until its computation began 27 hours after it did, 3 after it ended", () => {
    expect(FILLING_HOURS).toBe(27);
    expect(trendDailyQuery()).toContain(
      "max(computed_at) < addHours(toDateTime(min(day), 'UTC'), 27) AS filling"
    );
  });
});

describe("the two triggers", () => {
  test("sum together in every query; the trend sets push:main's part aside", () => {
    // No query groups or filters rows by trigger: each sums every row of a
    // key, push:main and other alike, into its runner-hours.
    for (const [name, sql] of Object.entries(READERS)) {
      expect([name, /GROUP BY[^)]*trigger/.test(sql)]).toEqual([name, false]);
      expect([name, /WHERE[^()]*trigger/.test(sql)]).toEqual([name, false]);
    }
    // The part of pushes to main, beside the whole, for cost per commit.
    const part =
      "sumIf(occupancy_runner_milliseconds, trigger = 'push:main') AS main_ms";
    for (const sql of TREND_ROLLUPS.map(trendQuery)) {
      expect(sql).toContain("sum(occupancy_runner_milliseconds) AS ms");
      expect(sql).toContain(part);
      expect(sql).toContain("AS main_runner_hours");
    }
    expect(trendDailyQuery()).toContain("AND trigger = 'push:main'");
    for (const sql of [runnerHoursQuery(), coverageQuery()]) {
      expect(sql).not.toMatch(/\btrigger\b/);
    }
  });
});

describe("the pushes to main", () => {
  test("are distinct head commits pushed to main, read by subcolumns", () => {
    const sql = trendPushesQuery();
    expect(sql).toContain("uniqExact(head_commit.id) AS pushes");
    expect(sql).toContain("repository.full_name = {repo: String}");
    expect(sql).toContain("ref IN ('refs/heads/main', 'refs/heads/master')");
    expect(sql).toContain("NOT deleted");
    // The quoted form (head_commit.'timestamp') prunes by the sort key but
    // reads whole tuples: 20 times the bytes for a year
    // (query-validation.md).
    expect(sql).not.toMatch(/(head_commit|repository)\.'/);
    expect(sql).toContain("head_commit.timestamp >= {start: DateTime64(3)}");
  });
});

describe("the daily totals", () => {
  test("count every day the rollup holds, not just the days the scope ran", () => {
    const daily = trendDailyQuery();
    const where = daily.slice(
      daily.indexOf("WHERE"),
      daily.indexOf("GROUP BY")
    );
    expect(where).not.toContain("{workflows: Array(String)}");
    expect(daily).toContain("sumIf(occupancy_runner_milliseconds, (empty(");
  });
});
