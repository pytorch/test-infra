// The trend and what changed, checked against each other and against the
// example JSONs beside this file, as consistency.test.ts checks the
// runner-hours panels: trend.json, an answer of GET /api/tests/cost/trend by
// day; changes.json, an answer of GET /api/tests/cost/changes for inductor
// over trend.json's A and B; and rates.json. At $1 an hour every figure is
// the runner-hours, to the bit, and at $r r times them; at the example rates
// each is its cells' runner-hours times their runner's rate, worked out from
// the JSONs alone; the owners table, the chart and the machines add up to
// their whole, per day and per commit; B's pace is the same figure wherever
// it shows; and a week or a month of the same days reads as the days do.

import {
  CostChangesSchema,
  type CostTrend,
  CostTrendSchema,
} from "lib/api/tests/cost/types";
import type { TrendRollup } from "lib/api/tests/cost/windows";
import {
  changeSummary,
  foldChanges,
  machineChanges,
} from "lib/tests/cost/changes";
import { parseRates, rateOf, type RatesFile } from "lib/tests/cost/rates";
import {
  budgetFacts,
  DEFAULT_TREND_SORT,
  type PeriodRange,
  prepareTrend,
  rangeDays,
  rangeDenominator,
  rangeTotals,
  rollupReady,
  TREND_SORT_KEYS,
  trendOwnerOrder,
  trendPace,
  type TrendPer,
  trendRows,
  trendSeries,
} from "lib/tests/cost/trend";
import CHANGES_JSON from "./changes.json";
import RATES_JSON from "./rates.json";
import TREND_JSON from "./trend.json";

const answer = CostTrendSchema.parse(TREND_JSON);
const changes = CostChangesSchema.parse(CHANGES_JSON);
const prepared = prepareTrend(answer);
const rates = parseRates(JSON.stringify(RATES_JSON), "rates.json");
// Oct 22 – Oct 28 and Oct 29 – Nov 4, as indexes into the days with data.
const A = { from: 0, to: 6 };
const B = { from: 7, to: 13 };
const PERS: TrendPer[] = ["day", "commit"];
const none = new Set<string>();

// Every runner label of both answers at one rate.
function flat(rate: number): RatesFile {
  const labels = new Set([...answer.labels, ...changes.labels]);
  return parseRates(
    JSON.stringify(Object.fromEntries(Array.from(labels, (l) => [l, rate]))),
    "flat.json"
  );
}
const one = flat(1);

const sum = (xs: Iterable<number>) => Array.from(xs).reduce((a, b) => a + b, 0);
const inRange = (day: string, from: string, to: string) =>
  day >= from && day <= to;
const A_DAYS = ["2026-10-22", "2026-10-28"] as const;
const B_DAYS = ["2026-10-29", "2026-11-04"] as const;

// trend.json's cells on some days, of some owners, from the JSON alone:
// [owner, label, runner-hours, push:main runner-hours].
function cellsOn(
  days: readonly [string, string],
  owners: string[] | null = null
): [string, string, number, number][] {
  return answer.cells
    .filter(
      ([p, o]) =>
        inRange(answer.periods[p], ...days) &&
        (owners === null || owners.includes(answer.owners[o]))
    )
    .map(([, o, l, h, main]) => [answer.owners[o], answer.labels[l], h, main]);
}

// $ of some cells at a rates file, from the JSON alone: each cell's hours
// times its label's rate, unpriced where there is none.
function priced(
  cells: [string, string, number, number][],
  r: RatesFile,
  main = false
): { value: number; unpriced: number } {
  let value = 0;
  let unpriced = 0;
  for (const [, label, h, m] of cells) {
    const rate = rateOf(r, label);
    if (rate === null) unpriced += main ? m : h;
    else value += (main ? m : h) * rate;
  }
  return { value, unpriced };
}

// trend.json rolled up by week or month, as GET /api/tests/cost/trend
// answers them: each day's cells summed into its period.
function rolledUp(rollup: TrendRollup): CostTrend {
  const startOf = (day: string) => {
    const d = new Date(`${day}T00:00:00Z`);
    const ms =
      rollup === "week"
        ? d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400000
        : Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    return new Date(ms).toISOString().slice(0, 10);
  };
  const periods = Array.from(new Set(answer.periods.map(startOf)));
  const sums = new Map<string, [number, number, number, number, number]>();
  for (const [p, o, l, h, main] of answer.cells) {
    const q = periods.indexOf(startOf(answer.periods[p]));
    const key = `${q}|${o}|${l}`;
    const cell = sums.get(key) ?? [q, o, l, 0, 0];
    cell[3] += h;
    cell[4] += main;
    sums.set(key, cell);
  }
  return {
    ...answer,
    rollup,
    start: periods[0],
    periods,
    cells: Array.from(sums.values()),
  };
}

describe("the example answers", () => {
  test("trend.json holds 259 runner-hours over A's 7 days and 266 over B's, 68.25 and 75.25 of them of pushes to main, over 70 and 56 pushes", () => {
    for (const [r, days, hours, main, pushes] of [
      [A, A_DAYS, 259, 68.25, 70],
      [B, B_DAYS, 266, 75.25, 56],
    ] as const) {
      const cells = cellsOn(days);
      expect(sum(cells.map((c) => c[2]))).toBe(hours);
      expect(sum(cells.map((c) => c[3]))).toBe(main);
      expect(rangeTotals(prepared, null, r).runnerHours).toBe(hours);
      expect(rangeTotals(prepared, null, r, null, "commit").runnerHours).toBe(
        main
      );
      expect(rangeDenominator(prepared, r, "day")).toBe(7);
      expect(rangeDenominator(prepared, r, "commit")).toBe(pushes);
    }
  });

  test("changes.json is inductor's part of the same days: its cells are trend.json's inductor cells by side and label, all and of pushes to main", () => {
    expect(changes.owners).toEqual(["inductor"]);
    for (const [side, days] of [
      [0, A_DAYS],
      [1, B_DAYS],
    ] as const) {
      const trendByLabel = new Map<string, [number, number]>();
      for (const [, label, h, main] of cellsOn(days, ["inductor"])) {
        const t = trendByLabel.get(label) ?? [0, 0];
        trendByLabel.set(label, [t[0] + h, t[1] + main]);
      }
      const changesByLabel = new Map(
        changes.cells
          .filter((c) => c[0] === side)
          .map(([, l, h, main]) => [changes.labels[l], [h, main]])
      );
      expect(changesByLabel).toEqual(trendByLabel);
    }
    // The same days, and the same pushes to main on them.
    const trendDays = new Map(
      answer.daily.days.map((d, i) => [d, answer.daily.pushes[i]])
    );
    for (const [day, pushes] of changes.days) {
      expect([day, trendDays.get(day)]).toEqual([day, pushes]);
    }
  });

  test("each day's totals are its cells summed over the owners", () => {
    for (const [d, day] of answer.daily.days.entries()) {
      const p = answer.periods.indexOf(day);
      if (p < 0) continue;
      const byLabel = (rows: [number, number, number][]) => {
        const m = new Map<number, [number, number]>();
        for (const [l, h, main] of rows) {
          const t = m.get(l) ?? [0, 0];
          m.set(l, [t[0] + h, t[1] + main]);
        }
        return m;
      };
      expect(
        byLabel(
          answer.daily.cells
            .filter((c) => c[0] === d)
            .map(([, l, h, main]) => [l, h, main])
        )
      ).toEqual(
        byLabel(
          answer.cells
            .filter((c) => c[0] === p)
            .map(([, , l, h, main]) => [l, h, main])
        )
      );
    }
  });

  test("no hour is negative, and every cell's push:main hours are part of its runner-hours", () => {
    const tuples = [
      ...answer.cells.map(([, , , h, main]) => [h, main]),
      ...answer.daily.cells.map(([, , h, main]) => [h, main]),
      ...changes.cells.map(([, , h, main]) => [h, main]),
    ];
    for (const [h, main] of tuples) {
      expect(main).toBeGreaterThanOrEqual(0);
      expect(main).toBeLessThanOrEqual(h);
    }
  });

  test("the schemas refuse a negative runner-hour", () => {
    const negative = (cells: unknown) => ({ ...TREND_JSON, cells });
    expect(
      CostTrendSchema.safeParse(negative([[0, 0, 0, -1, 0]])).success
    ).toBe(false);
    expect(
      CostTrendSchema.safeParse(negative([[0, 0, 0, 1, -0.5]])).success
    ).toBe(false);
    expect(
      CostTrendSchema.safeParse({
        ...TREND_JSON,
        daily: { ...TREND_JSON.daily, cells: [[0, 0, -2, 0]] },
      }).success
    ).toBe(false);
    expect(
      CostChangesSchema.safeParse({ ...CHANGES_JSON, cells: [[0, 0, -1, 0]] })
        .success
    ).toBe(false);
  });
});

describe("$1 an hour for every runner is the runner-hours", () => {
  test("the owners table, the chart, the ranges and the year to date, to the bit", () => {
    for (const per of PERS) {
      expect(
        trendRows(prepared, one, A, B, none, DEFAULT_TREND_SORT, true, 10, per)
      ).toEqual(
        trendRows(prepared, null, A, B, none, DEFAULT_TREND_SORT, true, 10, per)
      );
      expect(trendSeries(prepared, one, none, per).value).toEqual(
        trendSeries(prepared, null, none, per).value
      );
      for (const r of [A, B]) {
        const dollars = rangeTotals(prepared, one, r, null, per);
        const hours = rangeTotals(prepared, null, r, null, per);
        expect(dollars.value).toBe(hours.value);
        expect(dollars.unpriced).toBe(0);
      }
    }
    // The year to date: every daily cell, Mar 1's 8 h among them.
    const withBudget = parseRates(
      JSON.stringify({ rates: one.rates, budget: { annual: 1000 } }),
      "budget.json"
    );
    expect(budgetFacts(prepared, withBudget, B)?.ytd).toBe(
      sum(answer.daily.cells.map((c) => c[2]))
    );
  });

  test("what changed: the whole, each machine and each runner", () => {
    const machineOf = new Map<string, string>();
    for (const per of PERS) {
      const dollars = changeSummary(changes, one, per);
      const hours = changeSummary(changes, null, per);
      expect([dollars.aPer, dollars.bPer]).toEqual([hours.aPer, hours.bPer]);
      expect(
        machineChanges(changes, one, per, machineOf).map((m) => [
          m.row.aPer,
          m.row.bPer,
          m.runners.map((r) => [r.name, r.aPer, r.bPer]),
        ])
      ).toEqual(
        machineChanges(changes, null, per, machineOf).map((m) => [
          m.row.aPer,
          m.row.bPer,
          m.runners.map((r) => [r.name, r.aPer, r.bPer]),
        ])
      );
    }
  });
});

describe("$r an hour for every runner is r times the runner-hours", () => {
  test.each([0, 0.5, 2.75])("at $%p", (rate) => {
    const r = flat(rate);
    for (const per of PERS) {
      const dollars = trendRows(
        prepared,
        r,
        A,
        B,
        none,
        DEFAULT_TREND_SORT,
        true,
        10,
        per
      );
      const hours = trendRows(
        prepared,
        null,
        A,
        B,
        none,
        DEFAULT_TREND_SORT,
        true,
        10,
        per
      );
      // By key: at $0 every owner ties, so they sort by name.
      const byKey = new Map(hours.map((h) => [h.key, h]));
      expect(dollars.map((d) => d.key).sort()).toEqual(
        Array.from(byKey.keys()).sort()
      );
      for (const row of dollars) {
        const h = byKey.get(row.key)!;
        expect(row.bPer).toBeCloseTo(rate * h.bPer, 10);
        expect(row.aPer!).toBeCloseTo(rate * h.aPer!, 10);
        expect(row.bPerCommit!).toBeCloseTo(rate * h.bPerCommit!, 10);
      }
      expect(changeSummary(changes, r, per).bPer).toBeCloseTo(
        rate * changeSummary(changes, null, per).bPer,
        10
      );
    }
  });
});

describe("the example rates, worked by hand", () => {
  // rates.json prices avx512 at $0.50 and L4 at $1.25 an hour, and leaves
  // A10G and the XPU unpriced.
  test("every owner and every owner together, per day and per commit, is its cells times their rates over the days or the pushes", () => {
    for (const per of PERS) {
      const rows = trendRows(
        prepared,
        rates,
        A,
        B,
        none,
        DEFAULT_TREND_SORT,
        true,
        10,
        per
      );
      for (const row of rows.filter((r) => r.kind !== "more")) {
        const owners = row.kind === "all" ? null : row.owners;
        for (const [days, r, value] of [
          [A_DAYS, A, row.aPer],
          [B_DAYS, B, row.bPer],
        ] as const) {
          const cost = priced(cellsOn(days, owners), rates, per === "commit");
          expect([row.key, value]).toEqual([
            row.key,
            expect.closeTo(cost.value / rangeDenominator(prepared, r, per), 10),
          ]);
        }
      }
    }
    // Every owner: $164.50 over A's 7 days and $194.25 over B's, $23.50 and
    // $27.75 a day; of pushes to main, $45.50 over 70 pushes and $59.50 over
    // 56, $0.65 and $1.0625 a commit; 35 runner-hours unpriced in each.
    const all = trendRows(prepared, rates, A, B, none, DEFAULT_TREND_SORT)[0];
    expect([all.aPer, all.bPer, all.aPerCommit, all.bPerCommit]).toEqual([
      23.5, 27.75, 0.65, 1.0625,
    ]);
    expect([all.a?.unpriced, all.b.unpriced]).toEqual([35, 35]);
  });

  test("each machine of what changed is its labels' cells times their rates over the days or the pushes", () => {
    const machineOf = new Map(changes.labels.map((l) => [l, l]));
    const dayCount = { 0: 7, 1: 7 };
    const pushes = { 0: 70, 1: 56 };
    for (const per of PERS) {
      for (const m of machineChanges(changes, rates, per, machineOf)) {
        const l = changes.labels.indexOf(m.machine);
        const rate = rateOf(rates, m.machine);
        for (const side of [0, 1] as const) {
          const cell = changes.cells.find((c) => c[0] === side && c[1] === l);
          const hours =
            cell === undefined ? 0 : per === "day" ? cell[2] : cell[3];
          const den = per === "day" ? dayCount[side] : pushes[side];
          expect(side === 0 ? m.row.aPer : m.row.bPer).toBeCloseTo(
            rate === null ? 0 : (hours * rate) / den,
            10
          );
        }
      }
    }
  });
});

describe("every part adds up, per day and per commit, in runner-hours and at the example rates", () => {
  test("the owners table's rows, folded, listed or highlighted, in any order, with A or without, sum to every owner's; their shares to all of B", () => {
    for (const r of [null, rates]) {
      for (const per of PERS) {
        for (const by of TREND_SORT_KEYS) {
          for (const dir of ["desc", "asc"] as const) {
            for (const [expanded, top, lit, a] of [
              [false, 1, none, A],
              [true, 1, none, A],
              [true, 10, none, A],
              [false, 0, new Set(["distributed"]), A],
              [false, 1, none, null],
              [true, 1, none, null],
            ] as const) {
              const [all, ...rest] = trendRows(
                prepared,
                r,
                a,
                B,
                lit,
                { by, dir },
                expanded,
                top,
                per
              );
              for (const field of [
                "aPer",
                "bPer",
                "delta",
                "aPerCommit",
                "bPerCommit",
              ] as const) {
                expect([field, sum(rest.map((x) => x[field] ?? 0))]).toEqual([
                  field,
                  expect.closeTo(all[field] ?? 0, 10),
                ]);
              }
              expect(sum(rest.map((x) => x.share))).toBeCloseTo(1, 10);
            }
          }
        }
      }
    }
  });

  test("the Owner key steps through every row of the owners table, listed, in its order", () => {
    for (const r of [null, rates]) {
      for (const per of PERS) {
        for (const by of TREND_SORT_KEYS) {
          const sort = { by, dir: "desc" } as const;
          const listed = trendRows(prepared, r, A, B, none, sort, true, 10, per)
            .filter((x) => x.kind !== "all")
            .map((x) => x.key);
          expect(trendOwnerOrder(prepared, r, A, B, sort, per)).toEqual(listed);
        }
      }
    }
  });

  test("B's pace is one figure: the cards', the budget's and each owner's budget pill, per day whatever the table compares by", () => {
    const perDay = (owners: Set<string> | null) =>
      rangeTotals(prepared, rates, B, owners).value / rangeDays(prepared, B);
    expect(trendPace(prepared, perDay(null)).year).toBe(
      budgetFacts(prepared, rates, B)!.pace
    );
    for (const per of PERS) {
      const rows = trendRows(
        prepared,
        rates,
        A,
        B,
        none,
        DEFAULT_TREND_SORT,
        true,
        10,
        per
      ).filter((x) => x.budget !== null);
      // Every owner, inductor and dynamo have budgets.
      expect(rows.map((x) => x.key)).toEqual(["all", "inductor", "dynamo"]);
      for (const row of rows) {
        expect(row.budget!.pace).toBe(
          trendPace(
            prepared,
            perDay(row.kind === "all" ? null : new Set(row.owners))
          ).year
        );
      }
    }
    // A month is a twelfth of the year, so twelve make it.
    const { year, month } = trendPace(prepared, perDay(null));
    expect(12 * month).toBeCloseTo(year, 10);
  });

  test("the chart's bars over a range are the range: each a day's total per day, its value per push per commit", () => {
    for (const r of [null, rates]) {
      for (const range of [A, B]) {
        const day = trendSeries(prepared, r, none, "day").value;
        const commit = trendSeries(prepared, r, none, "commit").value;
        let dayTotal = 0;
        let commitTotal = 0;
        for (let i = range.from; i <= range.to; i++) {
          dayTotal += day[i];
          commitTotal += commit[i] * prepared.periodPushes[i];
        }
        expect(dayTotal).toBeCloseTo(rangeTotals(prepared, r, range).value, 10);
        expect(commitTotal).toBeCloseTo(
          rangeTotals(prepared, r, range, null, "commit").value,
          10
        );
      }
    }
  });

  test("what changed for inductor is the owners table's inductor row; its machines sum to it", () => {
    const machineOf = new Map<string, string>();
    for (const r of [null, rates]) {
      for (const per of PERS) {
        const row = trendRows(
          prepared,
          r,
          A,
          B,
          none,
          DEFAULT_TREND_SORT,
          true,
          10,
          per
        ).find((x) => x.key === "inductor")!;
        const summary = changeSummary(changes, r, per);
        expect(summary.aPer).toBeCloseTo(row.aPer!, 10);
        expect(summary.bPer).toBeCloseTo(row.bPer, 10);
        const machines = machineChanges(changes, r, per, machineOf);
        const all = foldChanges(
          "all",
          "All machines",
          machines.map((m) => m.row)
        );
        expect(all.bPer).toBeCloseTo(summary.bPer, 10);
        expect(all.delta).toBeCloseTo(summary.delta, 10);
      }
    }
  });
});

describe("a week or a month of the same days reads as the days", () => {
  const range = (
    p: ReturnType<typeof prepareTrend>,
    from: string,
    to: string
  ): PeriodRange => ({
    from: p.periods.findIndex((d) => d >= from),
    to: p.periods.findLastIndex((d) => d <= to),
  });
  const figures = (
    p: ReturnType<typeof prepareTrend>,
    r: RatesFile | null,
    a: PeriodRange,
    b: PeriodRange,
    per: TrendPer
  ) =>
    trendRows(p, r, a, b, none, DEFAULT_TREND_SORT, true, 10, per).map((x) => [
      x.key,
      x.aPer,
      x.bPer,
      x.aPerCommit,
      x.bPerCommit,
      x.share,
    ]);
  const close = (rows: unknown[][]) =>
    rows.map((row) =>
      row.map((v) => (typeof v === "number" ? expect.closeTo(v, 10) : v))
    );

  test.each([
    // The week of Oct 19 (data from Oct 22) against the whole week of Oct 26.
    ["week", ["2026-10-19", "2026-10-25"], ["2026-10-26", "2026-11-01"]],
    // October from Oct 22 against November through Nov 4.
    ["month", ["2026-10-01", "2026-10-31"], ["2026-11-01", "2026-11-04"]],
  ] as const)("by %s", (rollup, [aFrom, aTo], [bFrom, bTo]) => {
    const rolled = prepareTrend(rolledUp(rollup));
    const a = range(rolled, aFrom, aTo);
    const b = range(rolled, bFrom, bTo);
    expect([a.from, a.to, b.from, b.to]).toEqual([0, 0, 1, 1]);
    const dayA = range(prepared, aFrom, aTo);
    const dayB = range(prepared, bFrom, bTo);
    for (const r of [null, rates]) {
      for (const per of PERS) {
        expect(rangeTotals(rolled, r, b, null, per).value).toBeCloseTo(
          rangeTotals(prepared, r, dayB, null, per).value,
          10
        );
        expect(rangeDenominator(rolled, a, per)).toBe(
          rangeDenominator(prepared, dayA, per)
        );
        expect(figures(rolled, r, a, b, per)).toEqual(
          close(figures(prepared, r, dayA, dayB, per))
        );
      }
    }
  });
});

describe("which rollups the trend offers", () => {
  // trend.json ends Thursday Nov 5: its last whole week is Oct 26 – Nov 1,
  // the one before Oct 19 – 25; its last whole month October, then
  // September. Its days with data are Mar 1 and Oct 22 – Nov 4.
  const days = (from: string, to: string) => {
    const out: string[] = [];
    for (
      let ms = Date.parse(`${from}T00:00:00Z`);
      ms <= Date.parse(`${to}T00:00:00Z`);
      ms += 86400000
    ) {
      out.push(new Date(ms).toISOString().slice(0, 10));
    }
    return out;
  };
  const withDays = (list: string[], extra: Partial<CostTrend["daily"]> = {}) =>
    prepareTrend({
      ...answer,
      daily: {
        ...answer.daily,
        days: list,
        pushes: list.map(() => 0),
        cells: [],
        ...extra,
      },
    });

  test("a day always; a week or a month not before two whole ones have data", () => {
    expect(rollupReady(prepared, "day")).toBe(true);
    expect(rollupReady(prepared, "week")).toBe(false);
    expect(rollupReady(prepared, "month")).toBe(false);
    expect(rollupReady(withDays([]), "day")).toBe(true);
  });

  test("two whole weeks: every day of each, one still filling counted", () => {
    expect(
      rollupReady(withDays(days("2026-10-19", "2026-11-04")), "week")
    ).toBe(true);
    // Oct 20 missing.
    expect(
      rollupReady(
        withDays(
          days("2026-10-19", "2026-11-04").filter((d) => d !== "2026-10-20")
        ),
        "week"
      )
    ).toBe(false);
    // Nov 1 still filling counts, as the presets count it.
    expect(
      rollupReady(
        withDays(days("2026-10-19", "2026-11-04"), { filling: ["2026-11-01"] }),
        "week"
      )
    ).toBe(true);
    // The current week is partial, so it counts for neither.
    expect(
      rollupReady(withDays(days("2026-10-26", "2026-11-04")), "week")
    ).toBe(false);
  });

  test("two whole months; days before the answer's first count as data when the first has data", () => {
    expect(
      rollupReady(withDays(days("2026-09-01", "2026-11-04")), "month")
    ).toBe(true);
    expect(
      rollupReady(withDays(days("2026-09-02", "2026-11-04")), "month")
    ).toBe(false);
    // A day view on Jan 5 holds days from Nov 24: December is whole, and
    // the rollup ran on Nov 24, its first day, so November counts too.
    const january = (first: string) =>
      prepareTrend({
        ...answer,
        end: "2027-01-05",
        daily: {
          ...answer.daily,
          start: "2026-11-24",
          days: days(first, "2027-01-04"),
          pushes: days(first, "2027-01-04").map(() => 0),
          cells: [],
        },
      });
    expect(rollupReady(january("2026-11-24"), "month")).toBe(true);
    expect(rollupReady(january("2026-11-25"), "month")).toBe(false);
  });

  test("on a Monday or a 1st, the period just ended counts while its last day fills", () => {
    const on = (end: string, list: string[], filling: string[]) =>
      prepareTrend({
        ...answer,
        end,
        daily: {
          ...answer.daily,
          days: list,
          pushes: list.map(() => 0),
          cells: [],
          filling,
        },
      });
    // Monday Nov 2 with Sunday Nov 1 still filling: the weeks of Oct 19
    // and Oct 26.
    expect(
      rollupReady(
        on("2026-11-02", days("2026-10-19", "2026-11-01"), ["2026-11-01"]),
        "week"
      )
    ).toBe(true);
    expect(
      rollupReady(
        on("2026-11-02", days("2026-10-20", "2026-11-01"), ["2026-11-01"]),
        "week"
      )
    ).toBe(false);
    // November 1 with October 31 still filling: September and October.
    expect(
      rollupReady(
        on("2026-11-01", days("2026-09-01", "2026-10-31"), ["2026-10-31"]),
        "month"
      )
    ).toBe(true);
    expect(
      rollupReady(
        on("2026-11-01", days("2026-09-02", "2026-10-31"), ["2026-10-31"]),
        "month"
      )
    ).toBe(false);
  });
});
