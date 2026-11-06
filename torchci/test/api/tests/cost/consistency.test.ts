// The trend and the changes endpoints checked against each other: both read
// the same rows of ci.test_cost the same way, so for the same days, owners
// and workflows their runner-hours agree (live, to the rounding of their
// cells: query-validation.md); and the example answers beside the cost
// page's tests are what the endpoints make of their rows, so the page's
// tests read real answers.

import { compactChanges } from "lib/api/tests/cost/changes";
import {
  changesDaysQuery,
  changesQuery,
  trendDailyQuery,
  trendPushesQuery,
  trendQuery,
} from "lib/api/tests/cost/query";
import { compactTrend } from "lib/api/tests/cost/trend";
import { CostChangesSchema, CostTrendSchema } from "lib/api/tests/cost/types";
import CHANGES_JSON from "test/tests/cost/changes.json";
import TREND_JSON from "test/tests/cost/trend.json";

const trend = CostTrendSchema.parse(TREND_JSON);
const changes = CostChangesSchema.parse(CHANGES_JSON);

describe("the trend and the changes read the same rows the same way", () => {
  const trendSql = trendQuery("day");
  const daily = trendDailyQuery();
  const forOwners = changesQuery(true);
  const every = changesQuery(false);

  test("the rows of the scope, each day as last computed, by the runner labels a rates file prices", () => {
    const scope = `(empty({workflows: Array(String)})
      OR lower(replaceRegexpAll(workflow_path, '^.*/|[.]ya?ml$', '')) IN {workflows: Array(String)})`;
    for (const sql of [trendSql, daily, forOwners, every]) {
      expect(sql.replace(/\s+/g, " ")).toContain(scope.replace(/\s+/g, " "));
      expect(sql).toContain("(day, computed_at) IN (");
      expect(sql).toContain("SELECT day, max(computed_at) FROM ci.test_cost");
      expect(sql).toContain("arrayStringConcat(runner_labels, ',')");
    }
  });

  test("runner-hours as milliseconds over 3,600,000, rounded to 0.0001 h; those of pushes to main as the trigger push:main", () => {
    for (const sql of [trendSql, daily, forOwners, every]) {
      expect(sql).toMatch(/round\(sum[\s\S]*?\/ 3600000, 4\) AS runner_hours/);
      expect(sql).toContain("AS main_runner_hours");
      expect(sql).toContain("trigger = 'push:main'");
      expect(sql).not.toMatch(/trigger = 'other'/);
    }
  });

  test("an owner's share alike: a file's hours split evenly among its owners, the buckets for files without", () => {
    // The trend gives each owner of a cell 1 / length(owner_list) of it;
    // the changes give some owners arrayCount(theirs) / length(owner_list),
    // the sum of those shares.
    expect(trendSql).toContain("sum(ms / length(owner_list))");
    expect(trendSql).toContain("ARRAY JOIN owner_list AS owner");
    expect(forOwners).toContain(
      "arrayCount(owner -> has({owners: Array(String)}, owner), owner_list)\n      / length(owner_list) AS share"
    );
    const buckets = `multiIf(c.test_file = '', ['unattributed:no_test_reports'],
        empty(o.owners), ['unattributed:no_owner'], o.owners) AS owner_list`;
    for (const sql of [trendSql, forOwners]) {
      expect(sql.replace(/\s+/g, " ")).toContain(buckets.replace(/\s+/g, " "));
      expect(sql).toContain(
        "SELECT file, owners FROM ci.owners FINAL WHERE repo = {repo: String}"
      );
    }
  });

  test("pushes to main alike: distinct head commits pushed to main or master, by their day", () => {
    for (const sql of [changesDaysQuery(), trendPushesQuery()]) {
      expect(sql).toContain("uniqExact(head_commit.id) AS pushes");
      expect(sql).toContain("toDate(head_commit.timestamp)");
    }
  });
});

describe("the example answers are what the endpoints make of their rows", () => {
  test("trend.json: its cells, daily totals and pushes, as compactTrend answers them", () => {
    const rows = trend.cells.map(([p, o, l, h, main]) => ({
      period: trend.periods[p],
      owner: trend.owners[o],
      label: trend.labels[l],
      runner_hours: h,
      main_runner_hours: main,
    }));
    const filling = new Set(trend.daily.filling);
    const dailyRows = trend.daily.cells.map(([d, l, h, main]) => ({
      day_utc: trend.daily.days[d],
      label: trend.labels[l],
      runner_hours: h,
      main_runner_hours: main,
      filling: filling.has(trend.daily.days[d]) ? 1 : 0,
    }));
    const pushRows = trend.daily.days.map((day, d) => ({
      day_utc: day,
      pushes: trend.daily.pushes[d],
    }));
    expect(compactTrend(trend.periods, rows, dailyRows, pushRows)).toEqual({
      owners: trend.owners,
      labels: trend.labels,
      cells: trend.cells,
      daily: {
        days: trend.daily.days,
        filling: trend.daily.filling,
        pushes: trend.daily.pushes,
        cells: trend.daily.cells,
      },
    });
  });

  test("changes.json: its cells and days, as compactChanges answers them", () => {
    const rows = changes.cells.map(([side, l, h, main]) => ({
      side,
      label: changes.labels[l],
      runner_hours: h,
      main_runner_hours: main,
    }));
    const dayRows = changes.days.map(([day_utc, pushes]) => ({
      day_utc,
      pushes,
    }));
    expect(compactChanges(rows, dayRows)).toEqual({
      days: changes.days,
      labels: changes.labels,
      cells: changes.cells,
    });
  });
});
