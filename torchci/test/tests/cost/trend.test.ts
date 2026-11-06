// The cost page's trend, from the example answer beside this file
// (trend.json, an answer of GET /api/tests/cost/trend) and rates.json,
// worked by hand: 14 days with data, A (Oct 22 – 28) and B (Oct 29 – Nov 4)
// each a constant day, and March 1 in the daily totals only. At $1 an hour
// the trend is the runner-hours; the periods, presets, owner rows, the Owner
// key's order and steps and B's pace say what the hand says.

import { CostTrendSchema } from "lib/api/tests/cost/types";
import { parseRates, withRate } from "lib/tests/cost/rates";
import {
  axisPeriods,
  changeLabel,
  daysLabel,
  DEFAULT_TREND_SORT,
  defaultRanges,
  fillingIn,
  isFull,
  isLoneFilling,
  isPartial,
  nextTrendSort,
  ownerStep,
  paceCaveat,
  periodLabel,
  periodTitle,
  prepareTrend,
  rangeDates,
  rangeDays,
  rangeDenominator,
  rangeElapsed,
  rangeLabel,
  rangePushes,
  rangeTotals,
  TREND_TOP_OWNERS,
  trendOwnerOrder,
  trendPace,
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

  // An answer whose days from first through last have data and no hours,
  // some still filling.
  const dayList = (first: string, last: string) => {
    const out: string[] = [];
    for (let ms = Date.parse(first); ms <= Date.parse(last); ms += 86400000) {
      out.push(new Date(ms).toISOString().slice(0, 10));
    }
    return out;
  };
  const withDays = (
    list: string[],
    filling: string[],
    extra: Partial<typeof answer> = {}
  ) =>
    prepareTrend({
      ...answer,
      ...extra,
      cells: [],
      daily: {
        start: "2026-01-01",
        days: list,
        filling,
        pushes: list.map(() => 0),
        cells: [],
      },
    });

  test("a day still filling stays in a preset of several days; a preset of one day waits for it", () => {
    // Oct 21 – Nov 4 with Wednesday Nov 4 still filling: the last 7 days
    // and the 7 before still end at Nov 4; yesterday against Wednesday Oct
    // 28 waits.
    const filling = withDays(dayList("2026-10-21", "2026-11-04"), [
      "2026-11-04",
    ]);
    expect(
      trendPresets(filling).map((p) => [p.key, p.available, p.a, p.b])
    ).toEqual([
      ["day", false, { from: 7, to: 7 }, { from: 14, to: 14 }],
      ["7d", true, { from: 1, to: 7 }, { from: 8, to: 14 }],
      ["14d", false, null, null],
    ]);
    expect(trendPresets(filling).map((p) => p.waitsFor)).toEqual([
      ["2026-11-04"],
      [],
      [],
    ]);
    const ranges = defaultRanges(filling);
    expect([
      rangeLabel(filling, ranges.a!),
      rangeLabel(filling, ranges.b!),
    ]).toEqual(["Oct 22 – Oct 28", "Oct 29 – Nov 4"]);
    // Settled, the same days, and yesterday's preset too.
    const settled = withDays(dayList("2026-10-21", "2026-11-04"), []);
    expect(defaultRanges(settled)).toEqual(ranges);
    expect(trendPresets(settled).map((p) => p.available)).toEqual([
      true,
      true,
      false,
    ]);
    // A day missing is not waited for: it never comes.
    const gap = withDays(
      dayList("2026-10-21", "2026-11-04").filter((d) => d !== "2026-10-28"),
      ["2026-11-04"]
    );
    expect(
      trendPresets(gap).map((p) => [p.key, p.available, p.waitsFor])
    ).toEqual([
      ["day", false, []],
      ["7d", false, []],
      ["14d", false, []],
    ]);
    // With no preset, the default passes the lone day still filling by:
    // Nov 3 against Nov 2.
    expect(defaultRanges(gap)).toEqual({
      a: { from: 12, to: 12 },
      b: { from: 13, to: 13 },
    });
  });

  test("on a Monday with Sunday still filling, the last week and the last 4 weeks keep it", () => {
    const weeks = withDays(
      dayList("2026-08-31", "2026-11-01"),
      ["2026-11-01"],
      {
        rollup: "week",
        end: "2026-11-02",
        periods: [
          "2026-08-31",
          "2026-09-07",
          "2026-09-14",
          "2026-09-21",
          "2026-09-28",
          "2026-10-05",
          "2026-10-12",
          "2026-10-19",
          "2026-10-26",
        ],
      }
    );
    expect(
      trendPresets(weeks).map((p) => [p.key, p.available, p.a, p.b])
    ).toEqual([
      ["week", true, { from: 7, to: 7 }, { from: 8, to: 8 }],
      ["4w", true, { from: 1, to: 4 }, { from: 5, to: 8 }],
    ]);
    expect(isPartial(weeks, 8)).toBe(true);
    const ranges = defaultRanges(weeks);
    expect([
      rangeLabel(weeks, ranges.a!),
      rangeLabel(weeks, ranges.b!),
    ]).toEqual(["Sep 7 – Oct 4", "Oct 5 – Nov 1"]);
  });

  test("with no preset, the default passes by a week just begun on a day still filling", () => {
    // Tuesday Nov 3, Oct 21 missing, Monday Nov 2 still filling: the week
    // of Nov 2 is that day alone.
    const weeks = withDays(
      dayList("2026-09-07", "2026-11-02").filter((d) => d !== "2026-10-21"),
      ["2026-11-02"],
      {
        rollup: "week",
        end: "2026-11-03",
        periods: dayList("2026-09-07", "2026-11-02").filter(
          (d) => new Date(`${d}T00:00:00Z`).getUTCDay() === 1
        ),
      }
    );
    expect(trendPresets(weeks).some((p) => p.available)).toBe(false);
    expect(isLoneFilling(weeks, { from: 8, to: 8 })).toBe(true);
    const ranges = defaultRanges(weeks);
    expect([
      rangeLabel(weeks, ranges.a!),
      rangeLabel(weeks, ranges.b!),
    ]).toEqual(["Oct 19 – Oct 25", "Oct 26 – Nov 1"]);
  });
});

describe("the axis and the tooltips", () => {
  test("past 20 days the axis labels Mondays; fewer, every period up to 10, then every second", () => {
    expect(
      axisPeriods({ ...prepared, periods: prepared.periods.slice(0, 10) })
    ).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(
      axisPeriods({ ...prepared, periods: prepared.periods.slice(0, 11) })
    ).toEqual([0, 2, 4, 6, 8, 10]);
    expect(axisPeriods(prepared)).toEqual([0, 2, 4, 6, 8, 10, 12]);
    // 42 days from Thursday Sep 24: Mondays Sep 28 to Nov 2.
    expect(axisPeriods({ ...prepared, periods: answer.periods })).toEqual([
      4, 11, 18, 25, 32, 39,
    ]);
    // 21 days from Oct 15, and 20 from Oct 16.
    expect(
      axisPeriods({ ...prepared, periods: answer.periods.slice(21) })
    ).toEqual([4, 11, 18]);
    expect(
      axisPeriods({ ...prepared, periods: answer.periods.slice(22) })
    ).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18]);
    // Weeks keep every third of 26.
    expect(
      axisPeriods({
        ...prepared,
        rollup: "week",
        periods: answer.periods.slice(0, 26),
      })
    ).toEqual([0, 3, 6, 9, 12, 15, 18, 21, 24]);
  });

  test("a day's tooltip names its weekday; a week's or a month's is its label", () => {
    expect([0, 11, 13].map((i) => periodTitle(prepared, i))).toEqual([
      "Thu Oct 22",
      "Mon Nov 2",
      "Wed Nov 4",
    ]);
    const week = { ...prepared, rollup: "week" as const };
    const month = {
      ...prepared,
      rollup: "month" as const,
      periods: ["2026-10-01", "2026-11-01"],
    };
    expect([periodTitle(week, 11), periodTitle(month, 1)]).toEqual([
      "Nov 2",
      "Nov",
    ]);
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

  test("owners by B: per day, change, $ per runner-hour and per commit", () => {
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
      ["All owners", 194.25, 23.5, 27.75, 4.25, "▲ +18%"],
      ["inductor", 105, 12.5, 15, 2.5, "▲ +20%"],
      ["dynamo", 56, 10, 8, -2, "▼ −20%"],
      // Only in B: no change to speak of, but new.
      ["distributed", 26.25, 0, 3.75, 3.75, "new"],
      ["No owner", 7, 1, 1, 0, "—"],
      // Runner-hours with no rate keep their row, at $0.
      ["No test reports", 0, 0, 0, 0, "—"],
    ]);
    const [all, inductor] = rows;
    expect(inductor.share).toBeCloseTo(105 / 194.25, 12);
    // Per commit beside per day: inductor's push:main L4 hours, 3 a day at
    // $1.25 over 10 pushes, then 4 over 8; every owner's $6.50 a day over
    // 10 pushes, then $8.50 over 8.
    expect([inductor.aPerCommit, inductor.bPerCommit]).toEqual([0.375, 0.625]);
    expect([all.aPerCommit, all.bPerCommit]).toEqual([0.65, 1.0625]);
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

  test("the top owners and every highlighted one, the rest folded, never just one", () => {
    expect(TREND_TOP_OWNERS).toBe(8);
    const rows = (lit: Set<string>, expanded = false, top = 1) =>
      trendRows(prepared, rates, A, B, lit, DEFAULT_TREND_SORT, expanded, top);
    const labels = (lit: Set<string>, expanded = false, top = 1) =>
      rows(lit, expanded, top).map((r) => r.label);
    const everyone = [
      "All owners",
      "inductor",
      "dynamo",
      "distributed",
      "No owner",
      "No test reports",
    ];
    expect(labels(none)).toEqual([
      "All owners",
      "inductor",
      "2 more owners",
      "No owner",
      "No test reports",
    ]);
    // dynamo and distributed fold into one row: $8 + $3.75 a day in B,
    // $10 + $0 in A.
    const more = rows(none).find((r) => r.kind === "more")!;
    expect(more.owners).toEqual(["dynamo", "distributed"]);
    expect([more.aPer, more.bPer]).toEqual([10, 11.75]);
    // Listed, a last row folds them back; it stands for no owner.
    expect(labels(none, true)).toEqual([
      "All owners",
      "inductor",
      "dynamo",
      "distributed",
      "Show fewer",
      "No owner",
      "No test reports",
    ]);
    const less = rows(none, true).find((r) => r.kind === "less")!;
    expect(less).toMatchObject({
      owners: [],
      aPer: 0,
      bPer: 0,
      delta: 0,
      change: null,
      share: 0,
      aPerCommit: 0,
      bPerCommit: 0,
    });
    // Without A, its A figures are none, as every row's are.
    expect(
      trendRows(prepared, rates, null, B, none, DEFAULT_TREND_SORT, true, 1)
        .filter((r) => r.kind === "less")
        .map((r) => [r.aPer, r.bPer, r.delta, r.aPerCommit])
    ).toEqual([[null, 0, null, null]]);
    // A highlighted owner past the top keeps its row; one owner left over
    // keeps its own row too, folded or listed, and nothing folds back.
    expect(labels(new Set(["distributed"]))).toEqual(everyone);
    expect(labels(new Set(["dynamo", "distributed"]), true)).toEqual(everyone);
    expect(labels(none, false, 2)).toEqual(everyone);
    expect(labels(none, true, 2)).toEqual(everyone);
    // With none on top, the highlighted owner stays and the other two fold.
    const pinned = rows(new Set(["distributed"]), false, 0);
    expect(pinned.map((r) => r.label)).toEqual([
      "All owners",
      "distributed",
      "2 more owners",
      "No owner",
      "No test reports",
    ]);
    // $15 + $8 a day in B, $12.50 + $10 in A.
    expect(pinned[2].owners).toEqual(["inductor", "dynamo"]);
    expect([pinned[2].aPer, pinned[2].bPer]).toEqual([22.5, 23]);
    // Every owner of the example fits under the default top.
    expect(
      trendRows(prepared, rates, A, B, none, DEFAULT_TREND_SORT).map(
        (r) => r.label
      )
    ).toEqual(everyone);
  });

  test("the Owner key lists every owner in the table's order, then the buckets, and steps through them", () => {
    const order = trendOwnerOrder(prepared, rates, A, B, DEFAULT_TREND_SORT);
    expect(order).toEqual([
      "inductor",
      "dynamo",
      "distributed",
      "unattributed:no_owner",
      "unattributed:no_test_reports",
    ]);
    // The table's own order, whatever it is sorted by: by the change, $3.75
    // (distributed), $2.50 (inductor), then −$2 (dynamo).
    for (const sort of [
      DEFAULT_TREND_SORT,
      { by: "delta", dir: "desc" } as const,
      { by: "change", dir: "asc" } as const,
    ]) {
      expect(trendOwnerOrder(prepared, rates, A, B, sort)).toEqual(
        trendRows(prepared, rates, A, B, none, sort, true, Infinity)
          .filter((r) => r.kind === "owner" || r.kind === "bucket")
          .map((r) => r.key)
      );
    }
    expect(
      trendOwnerOrder(prepared, rates, A, B, { by: "delta", dir: "desc" })
    ).toEqual([
      "distributed",
      "inductor",
      "dynamo",
      "unattributed:no_owner",
      "unattributed:no_test_reports",
    ]);
    // In runner-hours, dynamo and inductor both ran 16 h a day in B: by
    // name.
    expect(
      trendOwnerOrder(prepared, null, A, B, DEFAULT_TREND_SORT).slice(0, 3)
    ).toEqual(["dynamo", "inductor", "distributed"]);
    // Per commit, by push:main value per push in B: inductor $0.625,
    // dynamo $0.25, distributed $0.15625.
    expect(
      trendOwnerOrder(
        prepared,
        rates,
        A,
        B,
        DEFAULT_TREND_SORT,
        "commit"
      ).slice(0, 3)
    ).toEqual(["inductor", "dynamo", "distributed"]);

    const step = (lit: string[], by: 1 | -1) =>
      ownerStep(order, new Set(lit), by);
    expect(step([], 1)).toEqual(["inductor"]);
    expect(step([], -1)).toBeNull();
    expect(step(["inductor"], 1)).toEqual(["dynamo"]);
    expect(step(["inductor"], -1)).toEqual([]);
    expect(step(["dynamo"], -1)).toEqual(["inductor"]);
    expect(step(["unattributed:no_test_reports"], 1)).toBeNull();
    expect(step(["unattributed:no_test_reports"], -1)).toEqual([
      "unattributed:no_owner",
    ]);
    // Several highlighted: from the first of them in the order.
    expect(step(["distributed", "dynamo"], 1)).toEqual(["distributed"]);
    expect(step(["distributed", "dynamo"], -1)).toEqual(["inductor"]);
    // One the order does not hold: as from every owner, or back to it.
    expect(step(["nobody"], 1)).toEqual(["inductor"]);
    expect(step(["nobody"], -1)).toEqual([]);
    expect(ownerStep([], none, 1)).toBeNull();
  });

  test("B's pace: per day kept up for the year, a month a twelfth of it", () => {
    // $27.75 a day for 2026's 365 days.
    expect(trendPace(prepared, 27.75)).toEqual({
      year: 10128.75,
      month: 844.0625,
    });
    expect(trendPace(prepared, 38)).toEqual({ year: 13870, month: 13870 / 12 });
    const perDay =
      rangeTotals(prepared, rates, B).value / rangeDays(prepared, B);
    expect(trendPace(prepared, perDay).year).toBe(10128.75);
    // inductor's $105 over 7 days, $15 a day.
    const inductor = trendPace(
      prepared,
      rangeTotals(prepared, rates, B, new Set(["inductor"])).value / 7
    );
    expect(inductor).toEqual({ year: 5475, month: 456.25 });
    // 2026 has 365 days; a leap year 366.
    expect(trendYear(prepared)).toEqual({ year: 2026, days: 365 });
    const leap = prepareTrend({ ...answer, end: "2029-01-01" });
    expect(trendYear(leap)).toEqual({ year: 2028, days: 366 });
    expect(trendPace(leap, 12)).toEqual({ year: 4392, month: 366 });
  });

  test("without A, no change and no order by it", () => {
    const rows = trendRows(prepared, rates, null, B, none, {
      by: "delta",
      dir: "desc",
    });
    expect(rows.every((r) => r.a === null && r.delta === null)).toBe(true);
    expect(rows.map(changeLabel).every((l) => l === "—")).toBe(true);
  });

  test("an edit in the key reprices the trend", () => {
    const a10g = withRate(rates, "mt-l-x86aavx2-11-41-a10g", 1);
    expect(trendSeries(prepared, a10g, none).value[13]).toBe(27.75 + 4);
    // B's 28 h of A10G, 4 a day, now at $1.
    expect(rangeTotals(prepared, a10g, B).value).toBe(194.25 + 28);
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

  test("a day still filling makes its period partial; the presets of several days keep it, yesterday's waits", () => {
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
    // Still whole: its warning says it reads low.
    expect([isFull(filling, B), isFull(filling, A)]).toEqual([true, true]);
    expect(fillingIn(filling, B)).toEqual(["2026-11-04"]);
    expect(fillingIn(filling, A)).toEqual([]);
    expect(
      [B, { from: 13, to: 13 }, { from: 12, to: 12 }].map((r) =>
        isLoneFilling(filling, r)
      )
    ).toEqual([false, true, false]);
    expect(
      trendPresets(filling).map((p) => [p.key, p.available, p.waitsFor])
    ).toEqual([
      ["day", false, ["2026-11-04"]],
      ["7d", true, []],
      ["14d", false, []],
    ]);
    // The last 7 days against the 7 before, as when nothing fills.
    expect(defaultRanges(filling)).toEqual({ a: A, b: B });
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

  test("when B's pace may mislead: all weekdays reads high, mostly or all weekend low", () => {
    // B has 2 weekend days of 7; Oct 29 – Nov 1, 2 of 4.
    expect(paceCaveat(prepared, B)).toBeNull();
    expect(paceCaveat(prepared, { from: 7, to: 10 })).toBeNull();
    // Wednesday Nov 4, and Monday to Wednesday.
    expect(paceCaveat(prepared, { from: 13, to: 13 })).toBe(
      "a weekday, so likely high"
    );
    expect(paceCaveat(prepared, { from: 11, to: 13 })).toBe(
      "all weekdays, so likely high"
    );
    // Sunday; Saturday and Sunday; Friday to Sunday.
    expect(paceCaveat(prepared, { from: 10, to: 10 })).toBe(
      "a weekend day, so likely low"
    );
    expect(paceCaveat(prepared, { from: 9, to: 10 })).toBe(
      "all weekend days, so likely low"
    );
    expect(paceCaveat(prepared, { from: 8, to: 10 })).toBe(
      "mostly weekend days, so likely low"
    );
    // A day still filling reads low whatever the day: its warning says so.
    const filling = prepareTrend({
      ...answer,
      daily: { ...answer.daily, filling: ["2026-11-04"] },
    });
    expect(paceCaveat(filling, { from: 13, to: 13 })).toBeNull();
    expect(paceCaveat(filling, { from: 11, to: 13 })).toBeNull();
    expect(paceCaveat(filling, { from: 12, to: 12 })).toBe(
      "a weekday, so likely high"
    );
    // By week: a whole week holds both kinds in their usual mix; the week
    // through yesterday, Monday Nov 2 to Wednesday Nov 4, does not.
    const week = prepareTrend({
      ...answer,
      rollup: "week",
      periods: ["2026-10-19", "2026-10-26", "2026-11-02"],
      cells: [],
    });
    // Thursday Oct 22 to Sunday Oct 25: 2 of 4.
    expect(paceCaveat(week, { from: 0, to: 0 })).toBeNull();
    expect(paceCaveat(week, { from: 1, to: 1 })).toBeNull();
    expect(paceCaveat(week, { from: 2, to: 2 })).toBe(
      "all weekdays, so likely high"
    );
  });

  test("a range's calendar days through yesterday, against its days with data", () => {
    expect(rangeElapsed(prepared, B)).toBe(7);
    expect(rangeDays(prepared, B)).toBe(7);
    // Without Nov 2's daily totals, B has data on 6 of its 7 days.
    const gone = answer.daily.days.indexOf("2026-11-02");
    const gappy = prepareTrend({
      ...answer,
      daily: {
        ...answer.daily,
        days: answer.daily.days.filter((_, d) => d !== gone),
        pushes: answer.daily.pushes.filter((_, d) => d !== gone),
        cells: answer.daily.cells
          .filter(([d]) => d !== gone)
          .map(([d, ...rest]) => [d > gone ? d - 1 : d, ...rest]),
      },
    } as typeof answer);
    expect([rangeDays(gappy, B), rangeElapsed(gappy, B)]).toEqual([6, 7]);
    expect([rangeDays(gappy, A), rangeElapsed(gappy, A)]).toEqual([7, 7]);
    // A week's days through yesterday: the current week's only so far.
    const week = prepareTrend({ ...answer, rollup: "week" });
    const last = week.periods.length - 1;
    expect(rangeElapsed(week, { from: last, to: last })).toBe(
      week.periodElapsed[last]
    );
  });
});
