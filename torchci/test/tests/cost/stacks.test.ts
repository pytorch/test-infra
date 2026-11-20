// The bars' stacks (lib/tests/cost/stacks.ts): the owner stack from trend.json
// sums to the old trendSeries totals (hours, per commit and $), keys keep a
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
import { parseRates, rateOf } from "lib/tests/cost/rates";
import { prepareRunnerHours } from "lib/tests/cost/runnerHours";
import { shownRange, trendContext } from "lib/tests/cost/select";
import {
  keyMembers,
  spanTotals,
  type StackOptions,
  trendStacks,
} from "lib/tests/cost/stacks";
import { prepareTrend, trendSeries } from "lib/tests/cost/trend";
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
const prepared = prepareTrend(answer);
// prepareTrend starts at the first period with data (Oct 22, the 29th day).
const offset = answer.periods.indexOf(prepared.periods[0]);
const rates = parseRates(JSON.stringify(RATES_JSON), "rates.json");
const runnerHours = prepareRunnerHours(ANSWER_JSON as never);
const colored = runnerHours.colored.map((m) => runnerHours.machines[m]);

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
    today: ctx.end,
    rate: (label, day) => (gaps.includes(day) ? null : price(label)),
    piece: () => ({ rate: null, priced: 0, exact: true, borrowed: false }),
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
    "sums to the old trendSeries totals per %s",
    (per) => {
      const st = trendStacks(fold, opts({ per }));
      const old = trendSeries(prepared, null, new Set(), per);
      fold.bars.forEach((_, i) => {
        const j = i - offset;
        expect(st.total[i]).toBeCloseTo(j < 0 ? 0 : old.value[j], 9);
      });
    }
  );

  it("sums to the old $ totals at one rate set", () => {
    const pricer = stubPricer((label) => rateOf(rates, label));
    const st = trendStacks(fold, opts({ unit: "usd", pricer }));
    const old = trendSeries(prepared, rates, new Set(), "day");
    expect(st.unit).toBe("usd");
    fold.bars.forEach((_, i) => {
      const j = i - offset;
      expect(st.total[i]).toBeCloseTo(j < 0 ? 0 : old.value[j], 9);
      expect(st.unpriced[i]).toBeCloseTo(j < 0 ? 0 : old.unpriced[j], 9);
    });
  });

  it("divides $ per day by priced days and leaves a gap day blank", () => {
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
    expect(usd.total[b]).toBeCloseTo((2 * priced) / 6, 9);
    expect(usd.unpriced[b]).toBeCloseTo(day("2026-10-27"), 9);
    expect(hours.total[b]).toBeCloseTo((priced + day("2026-10-27")) / 7, 9);
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
