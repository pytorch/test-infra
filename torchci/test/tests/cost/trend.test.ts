// The cost page's trend, from the example answer beside this file
// (trend.json, an answer of GET /api/tests/cost/trend) and rates.json with its
// budget, worked by hand: 14 days with data, A (Oct 22 – 28) and B (Oct 29 –
// Nov 4) each a constant day, and March 1 in the daily totals only. At $1 an
// hour the trend is the runner-hours; the periods, presets, owner rows and
// the year to date against the budget say what the hand says.

import { CostTrendSchema } from "lib/api/tests/cost/types";
import { parseRates, withRate } from "lib/tests/cost/rates";
import {
  budgetFacts,
  changeLabel,
  daysLabel,
  DEFAULT_TREND_SORT,
  defaultRanges,
  fillingIn,
  isFull,
  isPartial,
  nextTrendSort,
  ownersBudget,
  periodLabel,
  prepareTrend,
  rangeDates,
  rangeDays,
  rangeDenominator,
  rangeLabel,
  rangePushes,
  rangeTotals,
  trendPresets,
  trendRows,
  trendSeries,
  type TrendSort,
  trendSortInForce,
  trendYear,
  weekendDays,
  weekendMismatch,
} from "lib/tests/cost/trend";
import RATES_JSON from "./rates.json";
import TREND_JSON from "./trend.json";

const answer = CostTrendSchema.parse(TREND_JSON);
const prepared = prepareTrend(answer);
const rates = parseRates(JSON.stringify(RATES_JSON), "rates.json");
const A = { from: 0, to: 6 };
const B = { from: 7, to: 13 };
const none = new Set<string>();

// Every label of the trend at $1 an hour.
const one = parseRates(
  JSON.stringify(Object.fromEntries(answer.labels.map((l) => [l, 1]))),
  "one.json"
);

const sum = (xs: Iterable<number>) => Array.from(xs).reduce((a, b) => a + b, 0);

describe("the example trend answer", () => {
  test("is an answer of the API whose cells add up to its daily totals", () => {
    expect(answer.periods).toHaveLength(42);
    expect([answer.periods[0], answer.periods[41]]).toEqual([
      "2026-09-24",
      "2026-11-04",
    ]);
    // Day by day, the owners' cells are the day's labels.
    for (const [d, day] of answer.daily.days.entries()) {
      const p = answer.periods.indexOf(day);
      if (p < 0) continue;
      expect(sum(answer.cells.filter((c) => c[0] === p).map((c) => c[3]))).toBe(
        sum(answer.daily.cells.filter((c) => c[0] === d).map((c) => c[2]))
      );
    }
  });
});

describe("prepareTrend", () => {
  test("starts at the first period with data; every day of the 14 has data", () => {
    expect(prepared.periods).toHaveLength(14);
    expect([prepared.periods[0], prepared.periods[13]]).toEqual([
      "2026-10-22",
      "2026-11-04",
    ]);
    expect(prepared.periodDays.every((d) => d === 1)).toBe(true);
    expect(prepared.periodData.every((d) => d === 1)).toBe(true);
    expect(prepared.periodElapsed.every((d) => d === 1)).toBe(true);
    expect(periodLabel(prepared, 0)).toBe("Oct 22");
  });

  test("a week has 7 days, the current one those through yesterday; a month its own", () => {
    const week = prepareTrend({
      ...answer,
      rollup: "week",
      periods: ["2026-10-19", "2026-10-26", "2026-11-02"],
      cells: [
        [1, 0, 0, 1, 0],
        [2, 0, 0, 1, 0],
      ],
      daily: {
        start: "2026-01-01",
        pushes: [1, 2, 3, 4, 5, 6, 7, 8],
        days: [
          "2026-10-28",
          "2026-10-29",
          "2026-10-30",
          "2026-10-31",
          "2026-11-01",
          "2026-11-02",
          "2026-11-03",
          "2026-11-04",
        ],
        filling: [],
        cells: [],
      },
    });
    expect(week.periods).toEqual(["2026-10-26", "2026-11-02"]);
    expect([week.periodDays, week.periodElapsed, week.periodData]).toEqual([
      [7, 7],
      [7, 3],
      [5, 3],
    ]);
    expect(rangeLabel(week, { from: 0, to: 1 })).toBe("Oct 26 – Nov 4");
    // Neither week is whole: no week preset, so the last week with data
    // against the one before.
    expect(trendPresets(week).some((p) => p.available)).toBe(false);
    expect(defaultRanges(week)).toEqual({
      a: { from: 0, to: 0 },
      b: { from: 1, to: 1 },
    });
    const month = prepareTrend({
      ...answer,
      rollup: "month",
      end: "2027-01-05",
      periods: ["2026-11-01", "2026-12-01", "2027-01-01"],
      cells: [[2, 0, 0, 1, 0]],
      daily: {
        start: "2026-01-01",
        days: ["2027-01-02"],
        filling: [],
        pushes: [0],
        cells: [],
      },
    });
    expect([month.periodDays, month.periodElapsed]).toEqual([[31], [4]]);
    expect(periodLabel(month, 0)).toBe("Jan 2027");
  });

  test("an answer without data has no periods", () => {
    const empty = prepareTrend({
      ...answer,
      cells: [],
      daily: {
        start: "2026-01-01",
        days: [],
        filling: [],
        pushes: [],
        cells: [],
      },
    });
    expect(empty.periods).toEqual([]);
    expect(defaultRanges(empty)).toEqual({ a: null, b: null });
  });
});

describe("periods and presets", () => {
  test("the longest preset whose days all have data is the default: the last 7 days against the 7 before", () => {
    expect(
      trendPresets(prepared).map((p) => [p.key, p.available, p.a, p.b])
    ).toEqual([
      ["day", true, { from: 6, to: 6 }, { from: 13, to: 13 }],
      ["7d", true, A, B],
      // 28 days are needed; 14 have data.
      ["14d", false, null, null],
    ]);
    expect(defaultRanges(prepared)).toEqual({ a: A, b: B });
    expect([rangeLabel(prepared, A), rangeLabel(prepared, B)]).toEqual([
      "Oct 22 – Oct 28",
      "Oct 29 – Nov 4",
    ]);
    expect([isFull(prepared, A), rangeDays(prepared, B)]).toEqual([true, 7]);
  });
});

describe("$1 an hour for every runner is the runner-hours", () => {
  test("every period, range and row", () => {
    const hours = trendSeries(prepared, null, new Set(["inductor"]));
    const at1 = trendSeries(prepared, one, new Set(["inductor"]));
    expect(at1.value).toEqual(hours.value);
    expect(at1.highlighted).toEqual(hours.highlighted);
    expect(at1.unpriced).toEqual(new Float64Array(14));
    expect(rangeTotals(prepared, one, B)).toEqual(
      rangeTotals(prepared, null, B)
    );
    for (const per of ["day", "commit"] as const) {
      expect(trendSeries(prepared, one, none, per).value).toEqual(
        trendSeries(prepared, null, none, per).value
      );
      expect(
        trendRows(
          prepared,
          one,
          A,
          B,
          none,
          { by: "delta", dir: "desc" },
          false,
          10,
          per
        )
      ).toEqual(
        trendRows(
          prepared,
          null,
          A,
          B,
          none,
          { by: "delta", dir: "desc" },
          false,
          10,
          per
        )
      );
    }
  });
});

describe("the example rates, worked by hand", () => {
  const series = trendSeries(prepared, rates, new Set(["inductor"]));

  test("each day in $: A's $23.50 and B's $27.75, 5 h a day without a rate", () => {
    // A: 10 h × $1.25 + 20 h × $0.5 + 2 h × $0.5; B: 12 h × $1.25 + 16 h ×
    // $0.5 + 3 h × $1.25 + 2 h × $0.5. A10G and linux.idc.xpu have no rate.
    expect(Array.from(series.value)).toEqual([
      ...Array(7).fill(23.5),
      ...Array(7).fill(27.75),
    ]);
    expect(Array.from(series.highlighted)).toEqual([
      ...Array(7).fill(12.5),
      ...Array(7).fill(15),
    ]);
    expect(Array.from(series.unpriced)).toEqual(Array(14).fill(5));
    expect(Array.from(series.runnerHours)).toEqual([
      ...Array(7).fill(37),
      ...Array(7).fill(38),
    ]);
    expect(rangeTotals(prepared, rates, B, new Set(["inductor"]))).toEqual({
      value: 105,
      runnerHours: 112,
      unpriced: 28,
    });
  });

  test("owners by B: per day, change, $ per runner-hour and B's pace against each budget", () => {
    const rows = trendRows(prepared, rates, A, B, none, DEFAULT_TREND_SORT);
    expect(
      rows.map((r) => [
        r.label,
        r.b.value,
        r.aPer,
        r.bPer,
        r.delta,
        changeLabel(r),
      ])
    ).toEqual([
      ["All test hours", 194.25, 23.5, 27.75, 4.25, "▲ +18%"],
      ["inductor", 105, 12.5, 15, 2.5, "▲ +20%"],
      ["dynamo", 56, 10, 8, -2, "▼ −20%"],
      // Only in B: no change to speak of, but new.
      ["distributed", 26.25, 0, 3.75, 3.75, "new"],
      ["No owner", 7, 1, 1, 0, "—"],
      // Runner-hours with no rate keep their row, at $0.
      ["No test reports", 0, 0, 0, 0, "—"],
    ]);
    const [all, inductor, dynamo, distributed] = rows;
    expect(inductor.share).toBeCloseTo(105 / 194.25, 12);
    // Per commit beside per day: inductor's push:main L4 hours, 3 a day at
    // $1.25 over 10 pushes, then 4 over 8; every owner's $6.50 a day over
    // 10 pushes, then $8.50 over 8.
    expect([inductor.aPerCommit, inductor.bPerCommit]).toEqual([0.375, 0.625]);
    expect([all.aPerCommit, all.bPerCommit]).toEqual([0.65, 1.0625]);
    // $27.75 a day is $10,128.75 a year against $9,125; inductor's $15 a
    // day $5,475 against $4,000; dynamo's $8 $2,920 against $5,000.
    expect(all.budget).toEqual({
      annual: 9125,
      pace: 10128.75,
      ratio: 10128.75 / 9125,
    });
    expect(inductor.budget?.ratio).toBeCloseTo(5475 / 4000, 12);
    expect(dynamo.budget?.ratio).toBeCloseTo(2920 / 5000, 12);
    expect(distributed.budget).toBeNull();
    expect(Array.from(inductor.series)).toEqual(Array.from(series.highlighted));
  });

  test("sorted by a column, either way: every owner first and the buckets last whatever the order; rows without a value last either way", () => {
    // Per day in $: inductor $12.50 to $15 (+20%), dynamo $10 to $8
    // (−20%), distributed $0 to $3.75 (new, no %).
    const keys = (sort: TrendSort) =>
      trendRows(prepared, rates, A, B, none, sort).map((r) => r.key);
    expect(keys({ by: "delta", dir: "desc" })).toEqual([
      "all",
      "distributed",
      "inductor",
      "dynamo",
      "unattributed:no_owner",
      "unattributed:no_test_reports",
    ]);
    const owners = (by: TrendSort["by"], dir: TrendSort["dir"]) =>
      keys({ by, dir }).slice(1, 4);
    expect(owners("b", "desc")).toEqual(["inductor", "dynamo", "distributed"]);
    expect(owners("b", "asc")).toEqual(["distributed", "dynamo", "inductor"]);
    expect(owners("a", "desc")).toEqual(["inductor", "dynamo", "distributed"]);
    expect(owners("a", "asc")).toEqual(["distributed", "dynamo", "inductor"]);
    expect(owners("delta", "asc")).toEqual([
      "dynamo",
      "inductor",
      "distributed",
    ]);
    expect(owners("change", "desc")).toEqual([
      "inductor",
      "dynamo",
      "distributed",
    ]);
    expect(owners("change", "asc")).toEqual([
      "dynamo",
      "inductor",
      "distributed",
    ]);
  });

  test("a header's click sorts by its column largest first, and again the other way; without A, by B", () => {
    expect(DEFAULT_TREND_SORT).toEqual({ by: "b", dir: "desc" });
    expect(nextTrendSort(DEFAULT_TREND_SORT, "b")).toEqual({
      by: "b",
      dir: "asc",
    });
    expect(nextTrendSort({ by: "b", dir: "asc" }, "b")).toEqual({
      by: "b",
      dir: "desc",
    });
    expect(nextTrendSort({ by: "b", dir: "asc" }, "delta")).toEqual({
      by: "delta",
      dir: "desc",
    });
    expect(trendSortInForce({ by: "delta", dir: "asc" }, null)).toEqual(
      DEFAULT_TREND_SORT
    );
    expect(trendSortInForce({ by: "b", dir: "asc" }, null)).toEqual({
      by: "b",
      dir: "asc",
    });
    expect(trendSortInForce({ by: "change", dir: "asc" }, A)).toEqual({
      by: "change",
      dir: "asc",
    });
    expect(
      trendRows(prepared, rates, null, B, none, { by: "delta", dir: "asc" })
    ).toEqual(trendRows(prepared, rates, null, B, none, DEFAULT_TREND_SORT));
  });

  test("the top owners and every highlighted one, the rest folded", () => {
    const rows = (lit: Set<string>, expanded = false) =>
      trendRows(
        prepared,
        rates,
        A,
        B,
        lit,
        DEFAULT_TREND_SORT,
        expanded,
        1
      ).map((r) => r.label);
    expect(rows(none)).toEqual([
      "All test hours",
      "inductor",
      "2 more owners",
      "No owner",
      "No test reports",
    ]);
    expect(rows(new Set(["distributed"]))).toEqual([
      "All test hours",
      "inductor",
      "distributed",
      "1 more owner",
      "No owner",
      "No test reports",
    ]);
    expect(rows(none, true)).toHaveLength(6);
  });

  test("without A, no change and no order by it", () => {
    const rows = trendRows(prepared, rates, null, B, none, {
      by: "delta",
      dir: "desc",
    });
    expect(rows.every((r) => r.a === null && r.delta === null)).toBe(true);
    expect(rows.map(changeLabel).every((l) => l === "—")).toBe(true);
  });

  test("the year to date against the budget for its days with data, and B's pace a year", () => {
    // 7 × $23.50 + 7 × $27.75, and March 1's 8 h of L4 at $1.25; $9,125 a
    // year over 365 days is $25 a day, for 15 days with data.
    expect(budgetFacts(prepared, rates, B)).toEqual({
      year: 2026,
      annual: 9125,
      ytd: 368.75,
      ytdDays: 15,
      ytdUnpriced: 70,
      firstDay: "2026-03-01",
      toDate: 375,
      ratio: 368.75 / 375,
      pace: 10128.75,
    });
    // In runner-hours, or with no budget, none.
    expect(budgetFacts(prepared, null, B)).toBeNull();
    expect(budgetFacts(prepared, one, B)).toBeNull();
    expect(ownersBudget(rates.budget, ["inductor", "dynamo"])).toBe(9000);
    expect(ownersBudget(rates.budget, ["inductor", "distributed"])).toBeNull();
    expect(trendYear(prepared)).toEqual({ year: 2026, days: 365 });
  });

  test("an edit in the key reprices the trend", () => {
    const a10g = withRate(rates, "mt-l-x86aavx2-11-41-a10g", 1);
    expect(trendSeries(prepared, a10g, none).value[13]).toBe(27.75 + 4);
    expect(budgetFacts(prepared, a10g, B)?.ytd).toBe(368.75 + 14 * 4);
  });
});

describe("per commit", () => {
  test("push:main runner-hours over the pushes to main: each period, range and owner", () => {
    // Every owner's push:main hours, 9.75 a day over 10 pushes in A and
    // 10.75 over 8 in B; inductor's 4 and 5.
    const s = trendSeries(prepared, null, new Set(["inductor"]), "commit");
    expect(Array.from(s.value)).toEqual([
      ...Array(7).fill(0.975),
      ...Array(7).fill(1.34375),
    ]);
    expect(Array.from(s.highlighted)).toEqual([
      ...Array(7).fill(0.4),
      ...Array(7).fill(0.625),
    ]);
    expect([rangePushes(prepared, A), rangePushes(prepared, B)]).toEqual([
      70, 56,
    ]);
    expect(rangeDenominator(prepared, B, "commit")).toBe(56);
    expect(rangeDenominator(prepared, B, "day")).toBe(7);
    expect(
      rangeTotals(prepared, null, B, new Set(["inductor"]), "commit")
    ).toEqual({ value: 35, runnerHours: 35, unpriced: 0 });
    const rows = trendRows(
      prepared,
      null,
      A,
      B,
      none,
      DEFAULT_TREND_SORT,
      false,
      10,
      "commit"
    );
    const inductor = rows.find((r) => r.key === "inductor")!;
    expect([inductor.aPer, inductor.bPer]).toEqual([0.4, 0.625]);
    expect(inductor.share).toBeCloseTo(5 / 10.75, 12);
    expect(Array.from(inductor.series)).toEqual(Array.from(s.highlighted));
    // The budget's pace stays per day: $ a year is per day.
    const priced = trendRows(prepared, rates, A, B, none, DEFAULT_TREND_SORT);
    const pricedCommit = trendRows(
      prepared,
      rates,
      A,
      B,
      none,
      DEFAULT_TREND_SORT,
      false,
      10,
      "commit"
    );
    expect(pricedCommit[0].budget).toEqual(priced[0].budget);
  });

  test("an answer cached from before pushes were counted has none: no per-commit figure", () => {
    const { pushes: _pushes, ...daily } = answer.daily;
    const old = prepareTrend({ ...answer, daily } as typeof answer);
    expect(rangePushes(old, B)).toBe(0);
    const rows = trendRows(old, null, A, B, none, DEFAULT_TREND_SORT);
    expect(rows[0].bPerCommit).toBeNull();
  });
});

describe("changeLabel", () => {
  test("a sliver, a rise, a fall, new, and nothing", () => {
    expect(changeLabel({ change: 0.004, delta: 0.1 })).toBe("▲ <1%");
    expect(changeLabel({ change: -0.004, delta: -0.1 })).toBe("▼ <1%");
    expect(changeLabel({ change: 0.234, delta: 2 })).toBe("▲ +23%");
    expect(changeLabel({ change: null, delta: 2 })).toBe("new");
    expect(changeLabel({ change: null, delta: null })).toBe("—");
  });
});

describe("dates, days still filling and weekends", () => {
  test("a range's first and last day, as the changes take them and as words", () => {
    expect(rangeDates(prepared, A)).toEqual({
      from: "2026-10-22",
      to: "2026-10-28",
    });
    expect(rangeDates(prepared, { from: 13, to: 13 })).toEqual({
      from: "2026-11-04",
      to: "2026-11-04",
    });
    expect(daysLabel({ from: "2026-11-04", to: "2026-11-04" })).toBe("Nov 4");
    expect(daysLabel(rangeDates(prepared, B))).toBe(rangeLabel(prepared, B));
  });

  test("a day still filling makes its period partial, out of every preset and the default", () => {
    const filling = prepareTrend({
      ...answer,
      daily: { ...answer.daily, filling: ["2026-11-04"] },
    });
    expect(filling.periodFilling[13]).toBe(true);
    expect(filling.periodFilling.slice(0, 13).some(Boolean)).toBe(false);
    expect([isPartial(filling, 13), isPartial(filling, 12)]).toEqual([
      true,
      false,
    ]);
    expect([isFull(filling, B), isFull(filling, A)]).toEqual([false, true]);
    expect(fillingIn(filling, B)).toEqual(["2026-11-04"]);
    expect(fillingIn(filling, A)).toEqual([]);
    expect(trendPresets(filling).some((p) => p.available)).toBe(false);
    // The last settled day against the one before it.
    expect(defaultRanges(filling)).toEqual({
      a: { from: 11, to: 11 },
      b: { from: 12, to: 12 },
    });
    // Still a day with data: per day divides by it.
    expect(rangeDays(filling, B)).toBe(7);
  });

  test("an answer cached from before filling days were listed has none", () => {
    const { filling: _filling, ...daily } = answer.daily;
    const old = prepareTrend({ ...answer, daily } as typeof answer);
    expect(old.fillingDays).toEqual([]);
    expect(fillingIn(old, B)).toEqual([]);
    expect(defaultRanges(old)).toEqual(defaultRanges(prepared));
  });

  test("weekend days of a range, and when A and B mix them differently", () => {
    // Oct 24 and 25, then Oct 31 and Nov 1, are weekends.
    expect(weekendDays(prepared, A)).toEqual({ weekend: 2, days: 7 });
    expect(weekendDays(prepared, B)).toEqual({ weekend: 2, days: 7 });
    expect(weekendMismatch(prepared, A, B)).toBe(false);
    // Thursday Oct 22 against Thursday Oct 29.
    expect(
      weekendMismatch(prepared, { from: 0, to: 0 }, { from: 7, to: 7 })
    ).toBe(false);
    // Thursday to Saturday against a Sunday: a third against all.
    expect(
      weekendMismatch(prepared, { from: 0, to: 2 }, { from: 3, to: 3 })
    ).toBe(true);
    const week = prepareTrend({ ...answer, rollup: "week" });
    expect(weekendDays(week, { from: 0, to: 0 })).toBeNull();
  });
});
