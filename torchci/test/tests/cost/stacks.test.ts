// The bars' stacks (lib/tests/cost/stacks.ts): the owner stack from trend.json
// sums to each day's cells (hours, per commit and $), keys keep a
// fixed order, and each /series scope (the live series answers beside this
// file) stacks by machine, owner or one leaf series whose children add up to
// the day's total; a hovered drill row is lit at the baseline.

import {
  addDays,
  type BarsScope,
  type Day,
  type Pricer,
  type RatesSet,
} from "lib/api/tests/cost/contracts";
import { CostTrendSchema } from "lib/api/tests/cost/types";
import { foldBars, seriesDayCells, trendDayCells } from "lib/tests/cost/fold";
import { parseRates, rateOf, type RatesFile } from "lib/tests/cost/rates";
import { prepareRunnerHours } from "lib/tests/cost/runnerHours";
import { shownRange, trendContext } from "lib/tests/cost/select";
import {
  keyMembers,
  spanTotals,
  type StackOptions,
  trendStacks,
} from "lib/tests/cost/stacks";
import ANSWER_JSON from "./answer.json";
import RATES_JSON from "./rates.json";
import SERIES_MACHINE from "./series_machine.json";
import SERIES_OWNER from "./series_owner.json";
import SERIES_PAIR from "./series_pair.json";
import TREND_JSON from "./trend.json";

const answer = CostTrendSchema.parse(TREND_JSON);
const ctx = trendContext(answer);
const shown = shownRange("day", 42, ctx.end);
const fold = foldBars(trendDayCells(answer), "day", shown, ctx);
const rates = parseRates(JSON.stringify(RATES_JSON), "rates.json");
const runnerHours = prepareRunnerHours(ANSWER_JSON as never);
const colored = runnerHours.colored.map((m) => runnerHours.machines[m]);

// Each day's totals from trend.json's cells alone: its runner-hours, or per
// commit its push:main runner-hours over its pushes; with rates, in $ with
// the hours of labels without a rate apart.
function cellTotals(per: "day" | "commit", r: RatesFile | null = null) {
  const value = answer.periods.map(() => 0);
  const unpriced = answer.periods.map(() => 0);
  for (const [p, , l, h, main] of answer.cells) {
    const hours = per === "day" ? h : main;
    const rate = r === null ? 1 : rateOf(r, answer.labels[l]);
    if (rate === null) unpriced[p] += hours;
    else value[p] += hours * rate;
  }
  if (per === "commit") {
    answer.periods.forEach((day, p) => {
      const d = answer.daily.days.indexOf(day);
      const pushes = d < 0 ? 0 : answer.daily.pushes[d];
      value[p] = pushes > 0 ? value[p] / pushes : 0;
      unpriced[p] = pushes > 0 ? unpriced[p] / pushes : 0;
    });
  }
  return { value, unpriced };
}

const ROOT: BarsScope = {
  trail: [],
  root: "o",
  by: "o",
  fromTrend: true,
  preview: false,
  hover: null,
};

// A Pricer over one legacy rate map, every day priced but the gaps.
function stubPricer(
  price: (_label: string) => number | null,
  gaps: Day[] = []
): Pricer {
  const set: RatesSet = {
    file: "rates.json",
    metaFile: null,
    basis: null,
    generatedAt: null,
    legacy: true,
    periods: [],
  };
  return {
    set,
    rate: (label, day) => (gaps.includes(day) ? null : price(label)),
    piece: () => ({ rate: null, priced: 0, exact: true }),
    dayKind: (day) => (gaps.includes(day) ? "gap" : "legacy"),
    segments: () => [],
    coverageLine: () => null,
  };
}

const opts = (patch: Partial<StackOptions> = {}): StackOptions => ({
  repo: "pytorch/pytorch",
  unit: "hours",
  per: "day",
  pricer: null,
  scope: ROOT,
  colored,
  ...patch,
});

describe("the owner stack (owner root, /trend)", () => {
  it("names the stacked owners in a fixed order", () => {
    const st = trendStacks(fold, opts());
    expect(st.keys.map((k) => k.label)).toEqual([
      "inductor",
      "core_tests",
      "dynamo",
      "distributed",
      "functorch",
      "Other owners",
      "No owner",
      "No test reports",
    ]);
    expect(st.keys[7].paint).toEqual({ kind: "no_reports" });
  });

  it.each(["day", "commit"] as const)(
    "sums to each day's cells per %s",
    (per) => {
      const st = trendStacks(fold, opts({ per }));
      const want = cellTotals(per);
      expect(fold.bars.map((b) => b.start)).toEqual(answer.periods);
      fold.bars.forEach((_, i) => {
        expect(st.total[i]).toBeCloseTo(want.value[i], 9);
      });
    }
  );

  it("sums to each day's cells in $ at one rate set", () => {
    const pricer = stubPricer((label) => rateOf(rates, label));
    const st = trendStacks(fold, opts({ unit: "usd", pricer }));
    const want = cellTotals("day", rates);
    expect(st.unit).toBe("usd");
    fold.bars.forEach((_, i) => {
      expect(st.total[i]).toBeCloseTo(want.value[i], 9);
      expect(st.unpriced[i]).toBeCloseTo(want.unpriced[i], 9);
    });
  });

  it("sums a week bar (its priced days in $) and reads its span a week", () => {
    const pricer = stubPricer(() => 2, ["2026-10-27"]);
    const week = foldBars(
      trendDayCells(answer),
      "week",
      shownRange("week", 4, ctx.end),
      ctx
    );
    const hours = trendStacks(week, opts());
    const usd = trendStacks(week, opts({ unit: "usd", pricer }));
    const b = week.bars.findIndex((x) => x.start === "2026-10-26");
    expect(week.bars[b].data).toBe(7);
    expect(usd.pricedDays[b]).toBe(6);
    // $2 an hour over the 6 priced days; Oct 27's hours stay unpriced.
    const day = (d: string) =>
      answer.cells
        .filter(([p]) => answer.periods[p] === d)
        .reduce((x, c) => x + c[3], 0);
    const priced = ["2026-10-26", "2026-10-28", "2026-10-29", "2026-10-30"]
      .concat(["2026-10-31", "2026-11-01"])
      .reduce((x, d) => x + day(d), 0);
    expect(usd.total[b]).toBeCloseTo(2 * priced, 9);
    expect(usd.divisor[b]).toBe(1);
    expect(usd.unpriced[b]).toBeCloseTo(day("2026-10-27"), 9);
    expect(hours.total[b]).toBeCloseTo(priced + day("2026-10-27"), 9);
    // The week as A: a whole week is its total in hours; in $, a week with
    // any priced day counts whole, so it reads its priced days' $.
    const range = { from: "2026-10-26", to: "2026-11-01" };
    const h = spanTotals(week, hours, range);
    expect(h.units).toBe(1);
    expect(h.value).toBeCloseTo(hours.total[b], 9);
    const u = spanTotals(week, usd, range);
    expect(u.pricedDays).toBe(6);
    expect(u.pricedUnits).toBe(1); // a week with any priced day counts whole
    expect(u.value).toBeCloseTo(2 * priced, 9);
    // The same days in Day view: per day, as before.
    const d = spanTotals(fold, trendStacks(fold, opts()), range);
    expect(d.units).toBe(7);
    expect(d.value).toBeCloseTo(hours.total[b] / 7, 9);
  });

  it("reads A and B per day and per commit over their days", () => {
    const st = trendStacks(fold, opts());
    const a = spanTotals(fold, st, { from: "2026-10-22", to: "2026-10-28" });
    expect(a.days).toBe(7);
    expect(a.value).toBeCloseTo(a.hours / 7, 9);
    const commit = trendStacks(fold, opts({ per: "commit" }));
    const b = spanTotals(fold, commit, {
      from: "2026-10-29",
      to: "2026-11-04",
    });
    expect(b.pushes).toBe(56);
    expect(b.value).toBeCloseTo(b.hours / 56, 9);
  });

  it("lists Other owners' members on a bar", () => {
    const st = trendStacks(fold, opts({ repo: "example/repo" }));
    // Another repo names its top 5: here every owner, so none is Other.
    expect(st.keys.map((k) => k.id)).toEqual([
      "dynamo",
      "inductor",
      "distributed",
      "other_owners",
      "unattributed:no_owner",
      "unattributed:no_test_reports",
    ]);
    const k1 = trendStacks(fold, opts());
    const other = k1.keys.findIndex((k) => k.id === "other_owners");
    const members = keyMembers(fold, k1, other, 41);
    expect(members.map((m) => m.name)).toEqual([]); // dynamo is named
  });
});

// The series' last day + 1 as the answer's end.
function seriesFold(
  series: typeof SERIES_OWNER,
  rollup: "day" | "week" = "day"
) {
  const end = addDays(series.to, 1);
  const c = {
    end,
    firstDay: series.days[0],
    lastFull: addDays(end, -2),
    days: new Set(series.days),
    filling: new Set(series.filling),
  };
  return foldBars(
    seriesDayCells(series as never),
    rollup,
    shownRange(rollup, 14, end),
    c
  );
}

// Each bar's (a day's) hours straight from the answer's cells.
function barTotals(
  series: typeof SERIES_OWNER,
  f: ReturnType<typeof seriesFold>,
  child?: string
): number[] {
  return f.bars.map((bar) => {
    const d = series.days.indexOf(bar.start);
    return series.cells
      .filter(
        ([day, c]) =>
          day === d && (child === undefined || series.children[c] === child)
      )
      .reduce((x, c) => x + c[3], 0);
  });
}

describe("series stacks", () => {
  it("stacks an owner's machines in hue order; children sum to each day", () => {
    const f = seriesFold(SERIES_OWNER);
    const scope: BarsScope = {
      ...ROOT,
      trail: [{ dim: "o", value: "inductor" }],
      by: "m",
      fromTrend: false,
    };
    const st = trendStacks(f, opts({ scope }));
    expect(st.keys.map((k) => k.label)).toEqual([
      ...colored,
      "Other machines",
      "Unknown machine",
    ]);
    expect(st.keys[st.keys.length - 1].paint).toEqual({
      kind: "unknown_machine",
    });
    const totals = barTotals(SERIES_OWNER, f);
    expect(totals.every((t) => t > 0)).toBe(true);
    f.bars.forEach((_, i) => expect(st.total[i]).toBeCloseTo(totals[i], 6));
    // MI350X VF and amx have no hue in answer.json: Other machines.
    const other = st.keys.findIndex((k) => k.id === "other_machines");
    expect(st.keyTotals[other]).toBeGreaterThan(0);
  });

  it("stacks a machine's owners as the owner bars do", () => {
    const f = seriesFold(SERIES_MACHINE as never);
    const scope: BarsScope = {
      ...ROOT,
      trail: [{ dim: "m", value: "Linux x86_64 avx512" }],
      root: "m",
      by: "o",
      fromTrend: false,
    };
    const st = trendStacks(f, opts({ scope }));
    expect(st.keys.map((k) => k.id).slice(5)).toEqual([
      "other_owners",
      "unattributed:no_owner",
      "unattributed:no_test_reports",
    ]);
    const other = st.keys.findIndex((k) => k.id === "other_owners");
    const members = keyMembers(f, st, other, 0);
    expect(members.map((m) => m.name)).toContain("nn");
    expect(members.map((m) => m.name)).not.toContain("inductor");
    const values = members.map((m) => m.value);
    expect(values).toEqual([...values].sort((x, y) => y - x));
    expect(values.reduce((x, y) => x + y, 0)).toBeCloseTo(
      st.value[other][0],
      6
    );
    const totals = barTotals(SERIES_MACHINE as never, f);
    expect(st.total[0]).toBeCloseTo(totals[0], 6);
  });

  it("draws a pair's files as one series in the machine's hue", () => {
    const f = seriesFold(SERIES_PAIR as never);
    const scope: BarsScope = {
      ...ROOT,
      trail: [
        { dim: "o", value: "inductor" },
        { dim: "m", value: "Linux x86_64 avx512" },
      ],
      by: "f",
      fromTrend: false,
    };
    const st = trendStacks(f, opts({ scope }));
    expect(st.keys).toHaveLength(1);
    expect(st.keys[0].paint).toEqual({
      kind: "machine",
      position: colored.indexOf("Linux x86_64 avx512"),
    });
    const totals = barTotals(SERIES_PAIR as never, f);
    expect(st.total[3]).toBeCloseTo(totals[3], 6);
    // A hovered file row: its share lit at the baseline, the rest grey.
    const file = "test/inductor/test_flex_attention.py";
    const lit = trendStacks(
      f,
      opts({ scope: { ...scope, hover: { by: "f", children: [file] } } })
    );
    expect(lit.lit).toBe(0);
    expect(lit.keys.map((k) => k.paint.kind)).toEqual(["machine", "pale"]);
    expect(lit.value[0][3] + lit.value[1][3]).toBeCloseTo(totals[3], 6);
    const own = barTotals(SERIES_PAIR as never, f, file);
    expect(own[3]).toBeGreaterThan(0);
    expect(lit.value[0][3]).toBeCloseTo(own[3], 6);
  });

  it("lights a hovered owner outside the five in the accent", () => {
    const f = seriesFold(SERIES_MACHINE as never);
    const scope: BarsScope = {
      ...ROOT,
      trail: [{ dim: "m", value: "Linux x86_64 avx512" }],
      root: "m",
      by: "o",
      fromTrend: false,
      hover: { by: "o", children: ["nn"] },
    };
    const st = trendStacks(f, opts({ scope }));
    expect(st.lit).toBe(0);
    expect(st.keys[0]).toMatchObject({
      label: "nn",
      paint: { kind: "accent" },
    });
    const plain = trendStacks(f, opts({ scope: { ...scope, hover: null } }));
    expect(st.total[0]).toBeCloseTo(plain.total[0], 9);
  });
});
