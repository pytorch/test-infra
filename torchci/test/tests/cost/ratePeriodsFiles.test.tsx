// Rate-period files end to end: the FAKE fixtures' own promises, the
// reading rules ratePeriods.test.ts doesn't reach, and one set of
// synthetic day cells priced by every surface (the chart's bars and A/B, the
// drill's day pieces, the headline facts, the rate strip, the coverage
// banner) against an oracle that reads the JSON itself. Files: the FAKE
// weekly file (with its meta, Nov 9–15 is provisional; today is Nov 19, so
// Nov 16–18 borrow it), the gap file (no Nov 2–8), and the weekly rates cut
// on Thursdays, so every Mon–Sun side and week bar straddles a rate change.
// Every rate here is FAKE.

import ScopeHead from "components/tests/cost/drill/ScopeHead";
import { useDrill } from "components/tests/cost/drill/useDrill";
import RateStrip, { stripModel } from "components/tests/cost/rates/RateStrip";
import TrendsPanel from "components/tests/cost/trends/TrendsPanel";
import {
  addDays,
  type BarsScope,
  type CostCoverage,
  type CostCoverageJobs,
  type CostScope,
  costScopeUrl,
  costUnit,
  type Day,
  type DayRange,
  daysIn,
  type DrillQuery,
  type Per,
  type Pricer,
  type Rollup,
  type TrendsQuery,
} from "lib/api/tests/cost/contracts";
import type { CostTrend } from "lib/api/tests/cost/types";
import { coverageStrip } from "lib/tests/cost/coverage";
import { amount, levelView, pageFacts, rowByKey } from "lib/tests/cost/drill";
import { foldBars, trendDayCells } from "lib/tests/cost/fold";
import { fineAmountLabel } from "lib/tests/cost/query";
import {
  cadenceOf,
  dayTotals,
  makePricer,
  parseRatesFiles,
  periodTotals,
  pricingNotes,
  ratesChip,
  readRatesFiles,
} from "lib/tests/cost/ratePeriods";
import {
  resolveCompare,
  shownRange,
  trendContext,
} from "lib/tests/cost/select";
import { spanTotals, trendStacks } from "lib/tests/cost/stacks";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { SWRConfig } from "swr";
import JOBS_JSON from "./coverage_jobs.json";
import TESTS_JSON from "./coverage_tests.json";

// The Show key and the bar card are MUI menus and poppers, which want a
// browser; their words don't matter here.
jest.mock("components/tests/HeaderSelect", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("components/tests/cost/trends/TrendTooltip", () => ({
  __esModule: true,
  ...jest.requireActual("components/tests/cost/trends/TrendTooltip"),
  default: () => null,
}));

interface FilePeriod {
  valid_from: Day;
  valid_through: Day;
  rates: Record<string, number>;
  totals?: { aws_total: number; runner_nodes?: number };
}
interface FileJson {
  basis?: string;
  periods: FilePeriod[];
}

const REPO = "pytorch/pytorch";
const TODAY = "2026-11-19";
const file = (name: string) => ({
  name,
  text: readFileSync(join(__dirname, name), "utf8"),
});
const WEEKLY = file("rates_FAKE_weekly.json");
const META = file("rates_FAKE_weekly.meta.json");
const GAP = file("rates_FAKE_weekly_gap.json");
const weeklyJson: FileJson = JSON.parse(WEEKLY.text);
const gapJson: FileJson = JSON.parse(GAP.text);
const metaJson = JSON.parse(META.text);

// The weekly rates moved to Thursday–Wednesday periods, through yesterday
// (Nov 18), so nothing borrows: each Mon–Sun week holds two rate sets.
const midweekJson: FileJson = {
  ...weeklyJson,
  periods: weeklyJson.periods.map((p) => ({
    ...p,
    valid_from: addDays(p.valid_from, 3),
    valid_through: addDays(p.valid_through, 3),
  })),
};
const MIDWEEK = {
  name: "rates_FAKE_midweek.json",
  text: JSON.stringify(midweekJson),
};

const L1 = "mt-l-x86iavx512-16-128";
const L2 = "lf-l-x86aavx2-11-41-a10g";
// Missing from the weekly file's Oct 26 – Nov 1 period.
const PATCHY = "mt-l-arm64g4-16-62";
const UNPRICED = "linux.unpriced";
const LABELS = [L1, L2, PATCHY, UNPRICED];
const OWNERS = ["inductor", "dynamo"];

function span(from: Day, n: number): Day[] {
  return Array.from({ length: n }, (_, i) => addDays(from, i));
}

// Oct 29 (the data start) – Nov 18, every day whole: hours that differ by
// day, owner and label, an eighth of them on pushes to main.
const DAYS = span("2026-10-29", 21);
const PUSHES = DAYS.map((_, d) => 40 + (d % 5));
const hoursOf = (d: number, o: number, l: number) =>
  100 + 7 * d + 31 * o + 13 * l;
const mainOf = (h: number) => h / 8;

const TREND: CostTrend = {
  repo: REPO,
  rollup: "day",
  workflows: [],
  start: DAYS[0],
  end: TODAY,
  periods: DAYS,
  owners: OWNERS,
  labels: LABELS,
  cells: DAYS.flatMap((_, d) =>
    OWNERS.flatMap((_, o) =>
      LABELS.map((_, l): CostTrend["cells"][number] => [
        d,
        o,
        l,
        hoursOf(d, o, l),
        mainOf(hoursOf(d, o, l)),
      ])
    )
  ),
  daily: {
    start: "2026-01-01",
    days: DAYS,
    filling: [],
    pushes: PUSHES,
    cells: DAYS.flatMap((_, d) =>
      LABELS.map((_, l): CostTrend["daily"]["cells"][number] => {
        const h = hoursOf(d, 0, l) + hoursOf(d, 1, l);
        return [d, l, h, mainOf(h)];
      })
    ),
  },
  query_duration_ms: 1,
};
const CTX = trendContext(TREND);

const ROOT: BarsScope = {
  trail: [],
  root: "o",
  by: "o",
  fromTrend: true,
  preview: false,
  hover: null,
};

// ── The oracle: the file's JSON read directly ──
// A day takes the period holding it; after the last period, the days of
// the slot of the file's own grid holding yesterday take the last one.
function oracle(json: FileJson, today: Day) {
  const periods = [...json.periods].sort((x, y) =>
    x.valid_from < y.valid_from ? -1 : 1
  );
  const last = periods[periods.length - 1];
  const y = addDays(today, -1);
  const length = daysIn({ from: last.valid_from, to: last.valid_through });
  const after = addDays(last.valid_through, 1);
  const slot = (day: Day) =>
    Math.floor((daysIn({ from: after, to: day }) - 1) / length);
  const periodOf = (day: Day): FilePeriod | null => {
    const own = periods.find(
      (p) => p.valid_from <= day && day <= p.valid_through
    );
    if (own !== undefined) return own;
    return day > last.valid_through && day <= y && slot(day) === slot(y)
      ? last
      : null;
  };
  return {
    priced: (day: Day) => periodOf(day) !== null,
    rate: (label: string, day: Day): number | null => {
      const p = periodOf(day);
      return p === null ? null : rateIn(p.rates, label);
    },
  };
}

// A job's rate in one set: its one label besides self-hosted, else none.
function rateIn(rates: Record<string, number>, label: string): number | null {
  const keys = label.split(",").filter((l) => l !== "self-hosted");
  return keys.length === 1 && Object.hasOwn(rates, keys[0])
    ? rates[keys[0]]
    : null;
}
type Oracle = ReturnType<typeof oracle>;

// A range's sums as the oracle prices them, optionally one owner's.
function sums(o: Oracle, r: DayRange, owner?: number) {
  const t = {
    usd: 0,
    mainUsd: 0,
    hours: 0,
    unpriced: 0,
    days: 0,
    pricedDays: 0,
    pricedPushes: 0,
    // Hours on the priced days only (what the facts divide), and of them
    // those without a rate.
    countedHours: 0,
    countedMain: 0,
    countedUnpriced: 0,
    countedUnpricedMain: 0,
  };
  DAYS.forEach((day, d) => {
    if (day < r.from || day > r.to) return;
    t.days++;
    const priced = o.priced(day);
    if (priced) {
      t.pricedDays++;
      t.pricedPushes += PUSHES[d];
    }
    OWNERS.forEach((_, ow) => {
      if (owner !== undefined && ow !== owner) return;
      LABELS.forEach((label, l) => {
        const h = hoursOf(d, ow, l);
        const m = mainOf(h);
        const rate = o.rate(label, day);
        t.hours += h;
        if (priced) {
          t.countedHours += h;
          t.countedMain += m;
        }
        if (rate === null) {
          t.unpriced += h;
          if (priced) {
            t.countedUnpriced += h;
            t.countedUnpricedMain += m;
          }
        } else {
          t.usd += h * rate;
          t.mainUsd += m * rate;
        }
      });
    });
  });
  return t;
}

// ── The surfaces ──
const SHOW: Record<Rollup, number> = { day: 42, week: 13, month: 6 };
function chart(pricer: Pricer, rollup: Rollup, per: Per) {
  const shown = shownRange(rollup, SHOW[rollup], CTX.end);
  const folded = foldBars(trendDayCells(TREND), rollup, shown, CTX);
  const stacks = trendStacks(folded, {
    repo: REPO,
    unit: "usd",
    per,
    pricer,
    scope: ROOT,
    colored: [],
  });
  return { folded, stacks, at: (r: DayRange) => spanTotals(folded, stacks, r) };
}

// /scope at the owner root with day pieces, as the drill asks in $.
function dayScope(a: DayRange, b: DayRange): CostScope {
  const sides = [a, b].map((r) => DAYS.filter((d) => d >= r.from && d <= r.to));
  const pieces = sides.flatMap((days, side) =>
    days.map((day) => ({ side: side as 0 | 1, from: day, to: day }))
  );
  const cells: CostScope["cells"] = [];
  let piece = 0;
  sides.forEach((days, side) =>
    days.forEach((day) => {
      const d = DAYS.indexOf(day);
      OWNERS.forEach((_, o) =>
        LABELS.forEach((_, l) => {
          const h = hoursOf(d, o, l);
          cells.push([side, piece, o, l, h, mainOf(h)]);
        })
      );
      piece++;
    })
  );
  return {
    repo: REPO,
    workflows: [],
    trail: [],
    by: "o",
    a,
    b,
    piece: "day",
    sides: sides.map((days) => ({
      days,
      pushes: days.map((d) => PUSHES[DAYS.indexOf(d)]),
      filling: [] as Day[],
    })) as unknown as CostScope["sides"],
    pieces,
    children: OWNERS,
    info: OWNERS.map(() => ({})),
    labels: LABELS,
    cells,
    tests: [],
    query_duration_ms: 1,
  };
}

const near = (x: number | null | undefined, y: number, digits = 6) => {
  expect(x).not.toBeNull();
  expect(x).toBeCloseTo(y, digits);
};

function words(markup: string): string {
  return markup
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

describe("the FAKE fixtures", () => {
  test("every label both neighbours price changes at every boundary, and every week differs from every other", () => {
    const periods = weeklyJson.periods;
    expect(periods.map((p) => [p.valid_from, p.valid_through])).toEqual([
      ["2026-10-19", "2026-10-25"],
      ["2026-10-26", "2026-11-01"],
      ["2026-11-02", "2026-11-08"],
      ["2026-11-09", "2026-11-15"],
    ]);
    const labels = new Set(periods.flatMap((p) => Object.keys(p.rates)));
    for (const label of labels) {
      const rates = periods
        .filter((p) => Object.hasOwn(p.rates, label))
        .map((p) => p.rates[label]);
      expect([label, new Set(rates).size]).toEqual([label, rates.length]);
    }
    // One label left out of one week, on purpose.
    expect(Object.hasOwn(periods[1].rates, PATCHY)).toBe(false);
    expect(periods.filter((p) => Object.hasOwn(p.rates, PATCHY))).toHaveLength(
      3
    );
  });

  test("the gap file is the weekly file less Nov 2–8; the meta names the weekly file's periods; totals everywhere", () => {
    expect(gapJson.periods).toEqual(
      weeklyJson.periods.filter((p) => p.valid_from !== "2026-11-02")
    );
    const starts = new Set(weeklyJson.periods.map((p) => p.valid_from));
    for (const p of metaJson.periods)
      expect(starts.has(p.valid_from)).toBe(true);
    for (const json of [weeklyJson, gapJson]) {
      expect(json.basis).toMatch(/^FAKE synthetic rates for tests/);
      for (const p of json.periods) {
        expect(p.totals).toEqual({ aws_total: 200000, runner_nodes: 100000 });
      }
    }
  });
});

describe("reading rate-period files: what the other suites leave out", () => {
  // The one sentence a read fails with, "" when it reads.
  const error = (files: { name: string; text: string }[]) => {
    try {
      parseRatesFiles(files);
      return "";
    } catch (e) {
      return (e as Error).message;
    }
  };
  const one = (json: unknown, name = "f.json") =>
    error([{ name, text: JSON.stringify(json) }]);
  const ok = {
    valid_from: "2026-11-02",
    valid_through: "2026-11-08",
    rates: { a: 1 },
  };

  test("a period that isn't an object, lacks a day or holds bad rates fails with one sentence", () => {
    expect(one({ periods: [ok, "x"] })).toBe(
      "Period 2 must be an object with valid_from, valid_through and rates."
    );
    expect(one({ periods: [{ ...ok, valid_through: undefined }] })).toBe(
      "Period 1 (2026-11-02): valid_through must be a UTC day like 2026-11-02, got null."
    );
    expect(one({ periods: [{ ...ok, rates: [1] }] })).toBe(
      "Period 1 (2026-11-02..11-08): rates must be an object of runner label → $ per runner-hour."
    );
    expect(
      one({
        periods: [{ ...ok, rates: { a: -1, b: 100001, c: null, d: "1" } }],
      })
    ).toBe(
      "Period 1 (2026-11-02..11-08): rates must be numbers from 0 to 100,000: a is -1; b is 100001; c is null; and 1 more."
    );
    // Periods apart, in any order: the days between them are a gap.
    const apart = parseRatesFiles([
      {
        name: "apart.json",
        text: JSON.stringify({
          periods: [
            { ...ok, valid_from: "2026-11-16", valid_through: "2026-11-22" },
            ok,
          ],
        }),
      },
    ]);
    const pricer = makePricer(apart, "2026-11-23");
    expect(pricer.segments({ from: "2026-11-07", to: "2026-11-17" })).toEqual([
      { from: "2026-11-07", to: "2026-11-08", kind: "final", period: 0 },
      { from: "2026-11-09", to: "2026-11-15", kind: "gap", period: null },
      { from: "2026-11-16", to: "2026-11-17", kind: "final", period: 1 },
    ]);
  });

  test("a meta that isn't one: an array is a second rates file, and a periods map fails", () => {
    expect(error([WEEKLY, { name: "m.json", text: "[]" }])).toBe(
      "Drop one rates.json and, if you have it, its rates.meta.json."
    );
    expect(
      error([
        WEEKLY,
        {
          name: "m.json",
          text: '{"generated_at": "2026-11-19T06:00:00Z", "periods": {}}',
        },
      ])
    ).toBe("m.json: periods must be a list of {valid_from, status, window}.");
    // A window of null is no window.
    const meta = JSON.parse(META.text);
    meta.periods[3].window = null;
    const set = parseRatesFiles([
      WEEKLY,
      { name: "m.json", text: JSON.stringify(meta) },
    ]);
    expect(set.periods[3]).toMatchObject({
      status: "provisional",
      window: null,
    });
    expect(pricingNotes(makePricer(set, TODAY), ["2026-11-10"]).lines).toEqual([
      "Provisional: rates from Nov 9–15",
    ]);
  });

  test("cadence: daily, mixed", () => {
    const daily = parseRatesFiles([
      {
        name: "d.json",
        text: JSON.stringify({
          periods: span("2026-11-01", 3).map((d) => ({
            valid_from: d,
            valid_through: d,
            rates: { a: 1 },
          })),
        }),
      },
    ]);
    expect(cadenceOf(daily)).toBe("daily");
    expect(ratesChip(daily, true)).toBe("d.json · 3 daily periods");
    const mixed = parseRatesFiles([
      {
        name: "x.json",
        text: JSON.stringify({
          periods: [
            ok,
            { ...ok, valid_from: "2026-11-09", valid_through: "2026-11-09" },
          ],
        }),
      },
    ]);
    expect(cadenceOf(mixed)).toBeNull();
    expect(ratesChip(mixed, true)).toBe("x.json · 2 periods");
  });

  test("labels: self-hosted is dropped, a job of two labels has no rate, a 0 rate is a price", async () => {
    const pricer = makePricer(parseRatesFiles([WEEKLY]), TODAY);
    const r = weeklyJson.periods[2].rates[L1];
    for (const label of [L1, `self-hosted,${L1}`, `${L1},self-hosted`]) {
      expect(pricer.rate(label, "2026-11-03")).toBe(r);
    }
    expect(pricer.rate(`${L1},linux.foo`, "2026-11-03")).toBeNull();
    expect(pricer.rate("", "2026-11-03")).toBeNull();
    expect(pricer.rate(UNPRICED, "2026-11-03")).toBeNull();
    // A label one week lacks: priced by its own week on either side.
    expect(pricer.rate(PATCHY, "2026-10-25")).toBe(
      weeklyJson.periods[0].rates[PATCHY]
    );
    expect(pricer.rate(PATCHY, "2026-10-26")).toBeNull();
    expect(pricer.rate(PATCHY, "2026-11-02")).toBe(
      weeklyJson.periods[2].rates[PATCHY]
    );
    // The label check reads price keys: a self-hosted label matches, and
    // jobs of two labels price nothing, so they check nothing.
    const asFile = (f: { name: string; text: string }) =>
      new File([f.text], f.name, { type: "application/json" });
    await expect(
      readRatesFiles([asFile(WEEKLY)], [`self-hosted,${L1}`])
    ).resolves.toBeTruthy();
    await expect(
      readRatesFiles([asFile(WEEKLY)], [`linux.foo,linux.bar`])
    ).resolves.toBeTruthy();
    // A meta alone, read for the set held.
    const held = await readRatesFiles([asFile(WEEKLY)], [L1]);
    const joined = await readRatesFiles([asFile(META)], [L1], held);
    expect(joined.metaFile).toBe(META.name);
    expect(joined.periods[3].status).toBe("provisional");
    // 0 is a price: $0, priced, not unpriced.
    const free = makePricer(
      parseRatesFiles([
        {
          name: "free.json",
          text: JSON.stringify({
            periods: [
              {
                valid_from: "2026-10-26",
                valid_through: "2026-11-22",
                rates: Object.fromEntries(LABELS.map((l) => [l, 0])),
              },
            ],
          }),
        },
      ]),
      TODAY
    );
    const t = chart(free, "day", "day").at({
      from: "2026-11-02",
      to: "2026-11-08",
    });
    expect([t.usd, t.unpriced, t.pricedDays]).toEqual([0, 0, 7]);
    const v = levelView(
      dayScope(
        { from: "2026-11-02", to: "2026-11-08" },
        { from: "2026-11-09", to: "2026-11-15" }
      ),
      { unit: "usd", per: "day", pricer: free }
    );
    expect([v.total.a, v.total.totals.a.value, v.total.unpricedH]).toEqual([
      0, 0, 0,
    ]);
  });
});

// The same cells and A/B priced by each surface, per file.
const CASES: {
  name: string;
  files: { name: string; text: string }[];
  json: FileJson;
  a: DayRange;
  b: DayRange;
  approx: { a: boolean; b: boolean };
  segments: [Day, Day, string, number | null][];
}[] = [
  {
    name: "Thursday periods: every side and week straddles a rate change",
    files: [MIDWEEK],
    json: midweekJson,
    a: { from: "2026-11-02", to: "2026-11-08" },
    b: { from: "2026-11-09", to: "2026-11-15" },
    approx: { a: false, b: false },
    segments: [
      ["2026-10-29", "2026-11-04", "final", 1],
      ["2026-11-05", "2026-11-11", "final", 2],
      ["2026-11-12", "2026-11-18", "final", 3],
    ],
  },
  {
    name: "weekly with its meta: a provisional week and borrowed days",
    files: [WEEKLY, META],
    json: weeklyJson,
    a: { from: "2026-11-05", to: "2026-11-11" },
    b: { from: "2026-11-12", to: "2026-11-18" },
    approx: { a: false, b: true },
    segments: [
      ["2026-10-29", "2026-11-01", "final", 1],
      ["2026-11-02", "2026-11-08", "final", 2],
      ["2026-11-09", "2026-11-15", "provisional", 3],
      ["2026-11-16", "2026-11-18", "borrowed", 3],
    ],
  },
  {
    name: "the gap file: A has 3 of 7 days priced",
    files: [GAP],
    json: gapJson,
    a: { from: "2026-11-05", to: "2026-11-11" },
    b: { from: "2026-11-12", to: "2026-11-18" },
    approx: { a: true, b: true },
    segments: [
      ["2026-10-29", "2026-11-01", "final", 1],
      ["2026-11-02", "2026-11-08", "gap", null],
      ["2026-11-09", "2026-11-15", "final", 2],
      ["2026-11-16", "2026-11-18", "borrowed", 2],
    ],
  },
];

describe.each(CASES)(
  "every surface prices each day by its own period: $name",
  (c) => {
    const pricer = makePricer(parseRatesFiles(c.files), TODAY);
    const o = oracle(c.json, TODAY);
    const sides = { a: c.a, b: c.b } as const;

    test("the chart's A and B: $, unpriced hours and priced days, per bar and per commit", () => {
      const day = chart(pricer, "day", "day");
      const commit = chart(pricer, "day", "commit");
      for (const s of ["a", "b"] as const) {
        const want = sums(o, sides[s]);
        const t = day.at(sides[s]);
        near(t.usd, want.usd);
        near(t.unpriced, want.unpriced);
        expect(t.pricedDays).toBe(want.pricedDays);
        near(t.value, want.usd / want.pricedDays);
        near(commit.at(sides[s]).value, want.mainUsd / want.pricedPushes);
      }
      // The bars hold the same $: their totals over the side's days.
      const bars = day.folded.bars
        .map((bar, i) => ({ bar, i }))
        .filter(({ bar }) => bar.start >= c.b.from && bar.start <= c.b.to);
      expect(bars).toHaveLength(7);
      near(
        bars.reduce((t, { i }) => t + day.stacks.total[i], 0),
        sums(o, c.b).usd
      );
    });

    test("week bars: the same $, each side over the weeks it touches", () => {
      const week = chart(pricer, "week", "day");
      for (const s of ["a", "b"] as const) {
        const want = sums(o, sides[s]);
        const t = week.at(sides[s]);
        near(t.usd, want.usd);
        // Weeks with a priced day count, a partial one whole.
        const weeks = new Set(
          DAYS.filter(
            (d) => d >= sides[s].from && d <= sides[s].to && o.priced(d)
          ).map((d) =>
            addDays(d, -((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7))
          )
        ).size;
        expect(t.pricedUnits).toBe(weeks);
        near(t.value, want.usd / weeks);
      }
    });

    test("the drill's day pieces: the chart's $ to the cent, per child and per commit, ≈ only where a day borrows or lacks rates", () => {
      const scope = dayScope(c.a, c.b);
      const v = levelView(scope, { unit: "usd", per: "day", pricer });
      const day = chart(pricer, "day", "day");
      for (const s of ["a", "b"] as const) {
        const want = sums(o, sides[s]);
        const total = v.total.totals[s];
        near(total.value, want.usd);
        expect(total.approx).toBe(c.approx[s]);
        near(v.total[s], day.at(sides[s]).value);
        OWNERS.forEach((owner, ow) => {
          near(rowByKey(v, owner)?.totals[s].value, sums(o, sides[s], ow).usd);
        });
      }
      near(v.total.pct, day.at(c.b).value / day.at(c.a).value - 1, 9);
      near(v.total.unpricedH, sums(o, c.a).unpriced + sums(o, c.b).unpriced);
      // Per commit: $ of main hours over the priced days' pushes, as the chart.
      const commit = levelView(scope, { unit: "usd", per: "commit", pricer });
      const chartCommit = chart(pricer, "day", "commit");
      near(commit.total.a, chartCommit.at(c.a).value);
      near(commit.total.b, chartCommit.at(c.b).value);
      // Week Total: the chart's week figure.
      const week = levelView(scope, {
        unit: "usd",
        per: "day",
        pricer,
        rollup: "week",
      });
      const chartWeek = chart(pricer, "week", "day");
      near(week.total.a, chartWeek.at(c.a).value);
      near(week.total.b, chartWeek.at(c.b).value);
    });

    test("the headline facts: per day and per commit over the priced days, with the unpriced share", () => {
      const f = pageFacts(TREND, "usd", pricer);
      const all = sums(o, { from: DAYS[0], to: DAYS[DAYS.length - 1] });
      expect(f.days).toEqual(DAYS);
      near(f.perDay.value, all.usd / all.pricedDays);
      near(f.perCommit.value, all.mainUsd / all.pricedPushes);
      near(f.perDay.unpriced, all.countedUnpriced / all.countedHours);
      near(f.perCommit.unpriced, all.countedUnpricedMain / all.countedMain);
      expect(f.perDay.approx).toBe(c.approx.b);
      expect(f.perDay.priced).toEqual(
        all.pricedDays < DAYS.length
          ? { days: all.pricedDays, of: DAYS.length }
          : null
      );
      // Hours say no unpriced share.
      expect(pageFacts(TREND, "hours", pricer).perDay.unpriced).toBeNull();
    });

    test("the rate strip: the file's periods on the bars' axis, each segment's $ the oracle's", () => {
      const day = chart(pricer, "day", "day");
      const geometry = {
        bars: DAYS.map((start) => ({ start, days: 1 })),
        last: DAYS[DAYS.length - 1],
        priceSpan: (r: DayRange) => {
          const t = day.at(r);
          return { usd: t.usd, hours: t.hours, unpriced: t.unpriced };
        },
      };
      const model = stripModel(pricer, geometry);
      expect(model.map((s) => [s.from, s.to, s.kind, s.period])).toEqual(
        c.segments
      );
      for (const s of model) {
        const want = sums(o, s);
        near(s.usd, want.usd);
        if (s.kind === "gap") expect(s.rate).toBeNull();
        else near(s.rate, want.usd / (want.hours - want.unpriced), 9);
      }
      // Drawn, a segment per period: its spoken line names its days.
      const html = renderToStaticMarkup(
        <RateStrip pricer={pricer} {...geometry} onHoverSpan={() => {}} />
      );
      expect(html.match(/<li/g)).toHaveLength(c.segments.length);
    });

    test("drawn: the chart's A/B and the drill head read the same per-day $", () => {
      const query: TrendsQuery = {
        rollup: "day",
        show: null,
        cmp: null,
        a: c.a,
        b: c.b,
        per: "day",
        unit: "usd",
      };
      const compare = resolveCompare(query, CTX)!;
      expect([compare.a, compare.b]).toEqual([c.a, c.b]);
      const drillQuery: DrillQuery = {
        trail: [],
        root: "o",
        chg: "h",
        sort: "change",
        more: [],
        tests: false,
        cfg: null,
        cases: null,
        rank: null,
      };
      function Head() {
        const drill = useDrill({
          repo: REPO,
          workflows: [],
          compare,
          query: drillQuery,
          onQueryChange: () => {},
          per: "day",
          rollup: "day",
          unit: "usd",
          pricer,
          runnerHours: undefined,
        });
        return (
          <>
            <span data-url={drill.canvas.url} />
            <ScopeHead drill={drill} />
          </>
        );
      }
      const url = costScopeUrl(REPO, [], c.a, c.b, [], "o", "day");
      const html = renderToStaticMarkup(
        <SWRConfig
          value={{
            provider: () => new Map(),
            fallback: { [url]: dayScope(c.a, c.b) },
          }}
        >
          <TrendsPanel
            answer={TREND}
            context={CTX}
            loading={false}
            query={query}
            compare={compare}
            onQueryChange={() => {}}
            pricer={pricer}
            runnerHours={undefined}
            scope={ROOT}
            series={undefined}
            seriesLoading={false}
            workflowScope={null}
            slots={{ head: <Head /> }}
          />
        </SWRConfig>
      );
      expect(html).toContain(`data-url="${url.replace(/&/g, "&amp;")}"`);
      const w = words(html);
      for (const s of ["a", "b"] as const) {
        const want = sums(o, sides[s]);
        const name = s.toUpperCase();
        // The chart's tab: per bar ($ a day); ≈ only for borrowed days there.
        const borrowed = pricingNotes(
          pricer,
          DAYS.filter((d) => d >= sides[s].from && d <= sides[s].to)
        ).approx;
        expect(w).toContain(
          `${name} · ${borrowed ? "≈" : ""}${fineAmountLabel(
            costUnit("usd"),
            want.usd / want.pricedDays
          )} a day`
        );
        // The drill head's side total.
        const days =
          want.pricedDays < want.days
            ? `${want.pricedDays} of ${want.days} days priced`
            : `${want.days} days`;
        expect(w).toContain(
          `${name} total ${c.approx[s] ? "≈" : ""}${amount(
            "usd",
            want.usd
          )} · ${days}`
        );
      }
    });
  }
);

describe("the coverage banner's $ across a rate change and a totals change", () => {
  // B = Nov 12–18 (the captured coverage answers); today Nov 20. The weekly
  // file plus Nov 16–22 with its own rates and totals: B's first 4 days take
  // Nov 9–15's, its last 3 the new week's, nothing borrowed.
  const tests = TESTS_JSON as unknown as CostCoverage;
  const jobs = JOBS_JSON as unknown as CostCoverageJobs;
  const END = "2026-11-20";
  const B = { from: "2026-11-12", to: "2026-11-18" };
  const last = weeklyJson.periods[3];
  const extended: FileJson = {
    ...weeklyJson,
    periods: [
      ...weeklyJson.periods,
      {
        valid_from: "2026-11-16",
        valid_through: "2026-11-22",
        rates: Object.fromEntries(
          Object.entries(last.rates).map(([k, r]) => [
            k,
            Math.round(r * 150) / 100,
          ])
        ),
        totals: { aws_total: 350000, runner_nodes: 175000 },
      },
    ],
  };
  const pricer = makePricer(
    parseRatesFiles([
      { name: "rates_FAKE_extended.json", text: JSON.stringify(extended) },
    ]),
    END
  );
  const o = oracle(extended, END);
  const PAGE_SEGMENTS = new Set([0, 1, 2]); // running, setup_idle, no_reports

  test("each day takes its own period's totals, and its job $ its own rates", () => {
    expect(periodTotals(pricer.set.periods[4])).toEqual({
      aws_total: 350000,
      runner_nodes: 175000,
    });
    expect(dayTotals(pricer, "2026-11-15")).toEqual({
      aws_total: 200000 / 7,
      runner_nodes: 100000 / 7,
    });
    expect(dayTotals(pricer, "2026-11-16")).toEqual({
      aws_total: 350000 / 7,
      runner_nodes: 175000 / 7,
    });
    const strip = coverageStrip(tests, jobs, B, pricer, "usd");
    expect(strip.borrowed).toBe(false);
    const bill = strip.bill!;
    expect([bill.days, bill.of]).toEqual([7, 7]);
    near(bill.aws, (4 * 200000 + 3 * 350000) / 7, 3);
    near(bill.nodes, (4 * 100000 + 3 * 175000) / 7, 3);
    // This page's $: its test hours, each at its day's rate.
    let page = 0;
    let flat = 0;
    for (const [di, si, li, h] of tests.cells) {
      const day = tests.days[di];
      if (day < B.from || day > B.to || !PAGE_SEGMENTS.has(si)) continue;
      const label = tests.labels[li];
      page += h * (o.rate(label, day) ?? 0);
      flat += h * (rateIn(last.rates, label) ?? 0);
    }
    near(strip.page, page, 3);
    near(bill.page, page, 3);
    // Priced with Nov 9–15 all week, it would read lower.
    expect(page / flat).toBeGreaterThan(1.1);
    // The ghost: the bill above the jobs.
    near(strip.outside?.value, bill.aws - strip.jobs, 3);
  });
});
