// The owner bars' model (lib/tests/cost/ownerBars.ts) from owners_b.json (B =
// Nov 11–17, answer.json's rows, each row's cells 0.2, 0.2, 0.1, 0.1, 0.2,
// 0.1 and 0.1 of its hours by day): the keys' days, the page's hues by name,
// a click as the drill's pill, $ priced day by day with FAKE rates (never a
// day's rate for another), B's total as the drill's head reads it, and the
// runners of a row or a machine adding up, with their $/h.

import { createTheme } from "@mui/material/styles";
import {
  addDays,
  COMPARE_PRESETS,
  type CostOwners,
  type Day,
  type Pill,
  type TrendContext,
  type TrendsQuery,
} from "lib/api/tests/cost/contracts";
import { barFill, machineHue, runnerFill } from "lib/tests/cost/colors";
import {
  lastDays,
  machineKeyRows,
  noRateRunners,
  type OwnerBarsModel,
  ownerBarsModel,
  ownerPresetChoices,
  ownerPresetInForce,
  ownerPresetPatch,
  ownerRows,
  paintOf,
  priceOwners,
  rateText,
  runnerBreakdown,
  sumFigures,
  togglePill,
  trailChoices,
  withHues,
} from "lib/tests/cost/ownerBars";
import { makePricer, parseRatesFiles } from "lib/tests/cost/ratePeriods";
import { NOT_PROBED, prepareRunnerHours } from "lib/tests/cost/runnerHours";
import { presetPatch, resolveCompare } from "lib/tests/cost/select";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import OWNERS_JSON from "./owners_b.json";

const OWNERS = OWNERS_JSON as unknown as CostOwners;
const HOURS: CostOwners = { ...OWNERS, piece: null, cells: [] };

const pricerOf = (...names: string[]) =>
  makePricer(
    parseRatesFiles(
      names.map((name) => ({
        name,
        text: readFileSync(join(__dirname, name), "utf8"),
      }))
    )
  );
const WEEKLY = pricerOf(
  "rates_FAKE_weekly.json",
  "rates_FAKE_weekly.meta.json"
);
const GAP = pricerOf("rates_FAKE_weekly_gap.json");

// The answer with only some rows, cells renumbered.
function only(
  answer: CostOwners,
  keep: (_row: CostOwners["rows"][number]) => boolean
): CostOwners {
  const index = new Map<number, number>();
  const rows = answer.rows.filter((r, i) => {
    if (!keep(r)) return false;
    index.set(i, index.size);
    return true;
  });
  return {
    ...answer,
    rows,
    cells: answer.cells
      .filter(([, r]) => index.has(r))
      .map(([d, r, h]) => [d, index.get(r) as number, h]),
  };
}

const sum = (xs: Float64Array) => xs.reduce((a, b) => a + b, 0);
const o = (value: string): Pill => ({ dim: "o", value });
const m = (value: string): Pill => ({ dim: "m", value });
const f = (value: string): Pill => ({ dim: "f", value });

describe("hues", () => {
  test("B's machines take the page's hue positions by name; a machine B lacks leaves its hue unused", () => {
    const own = prepareRunnerHours(OWNERS);
    const p = withHues(own, ["Apple M1", "NVIDIA H100", "NVIDIA L4"]);
    const index = (name: string) => p.machines.indexOf(name);
    expect(p.colored).toEqual([index("Apple M1"), -1, index("NVIDIA L4")]);
    const theme = createTheme({ palette: { mode: "dark" } });
    const page = { colored: [0, 1, 2] } as unknown as typeof p;
    expect(machineHue(theme, p, index("Apple M1"))).toBe(
      machineHue(theme, page, 0)
    );
    expect(machineHue(theme, p, index("NVIDIA L4"))).toBe(
      machineHue(theme, page, 2)
    );
    // Not among the page's: the other machines' grey.
    expect(paintOf(p, index("Linux x86_64 avx512"))).toEqual({ kind: "other" });
    expect(paintOf(p, index(NOT_PROBED))).toEqual({ kind: "not_probed" });
    // Without the page's, B keeps its own.
    expect(withHues(own, undefined)).toBe(own);
  });
});

describe("a click is the drill's pill", () => {
  test("appends, swaps keeping the deeper pills, drops; the trail stays structural", () => {
    expect(togglePill([], o("inductor"))).toEqual([o("inductor")]);
    expect(togglePill([o("inductor")], o("inductor"))).toEqual([]);
    expect(togglePill([o("inductor"), f("test_a.py")], o("dynamo"))).toEqual([
      o("dynamo"),
      f("test_a.py"),
    ]);
    expect(togglePill([o("inductor")], m("NVIDIA L4"))).toEqual([
      o("inductor"),
      m("NVIDIA L4"),
    ]);
    // A file needs an owner or a machine before it.
    expect(togglePill([o("inductor"), f("test_a.py")], o("inductor"))).toEqual(
      []
    );
    expect(trailChoices([o("inductor"), m("NVIDIA L4"), f("x")])).toEqual({
      workflows: [],
      owners: ["inductor"],
      machines: ["NVIDIA L4"],
    });
  });
});

describe("pricing day by day", () => {
  // One label's hour on each of Nov 7–10: FAKE weekly prices Nov 2–8 at
  // 0.45 and Nov 9–15 at 0.55; the gap file leaves Nov 2–8 out.
  const crossing: CostOwners = {
    ...only(OWNERS, (r) => r.label === "mt-l-x86aavx2-11-41-l4"),
    from: "2026-11-07",
    to: "2026-11-10",
    days: ["2026-11-07", "2026-11-08", "2026-11-09", "2026-11-10"],
  };
  crossing.rows = crossing.rows.slice(0, 1);
  crossing.cells = [0, 1, 2, 3].map(
    (d) => [d, 0, 1] as [number, number, number]
  );

  test("each day at its own period's rate", () => {
    const p = priceOwners(crossing, WEEKLY);
    expect(p.usd[0]).toBeCloseTo(0.45 * 2 + 0.55 * 2, 10);
    expect(p.unpriced[0]).toBe(0);
    expect(p.hours[0]).toBe(4);
  });

  test("a day in no period stays unpriced, never priced at a neighbour's rate", () => {
    const p = priceOwners(crossing, GAP);
    expect(p.usd[0]).toBeCloseTo(0.55 * 2, 10);
    expect(p.unpriced[0]).toBe(2);
  });

  test("labels without a rate stay unpriced on priced days", () => {
    const p = priceOwners(OWNERS, WEEKLY);
    const amd = OWNERS.rows.findIndex(
      (r) => r.label === "amd-dpx-linux.rocm.gpu.gfx950.1"
    );
    expect(p.usd[amd]).toBe(0);
    expect(p.unpriced[amd]).toBeCloseTo(40, 6);
    // Every row's cells hold all its hours.
    expect(sum(p.hours)).toBeCloseTo(578, 6);
  });
});

describe("the model", () => {
  test("hours: B's total is its rows', over its days", () => {
    const model = ownerBarsModel(HOURS, { pricer: null, trail: [] });
    expect(model.unit).toBe("hours");
    expect(model.total.value).toBe(578);
    expect(model.total.days).toBe("7 days");
    expect(model.total.approx).toBe(false);
    expect(model.view).toBe(model.hours);
    expect(
      ownerRows(model.view, { expanded: false, bucketsOpen: false }).map(
        (r) => [r.label, r.hours]
      )
    ).toEqual([
      ["inductor", 260],
      ["dynamo", 137.4],
      ["distributed", 90],
      ["Unattributed", 90.6],
    ]);
  });

  test("the trail highlights: its owner and machine, names B lacks dropped", () => {
    const model = ownerBarsModel(HOURS, {
      pricer: null,
      trail: [o("inductor"), m("NVIDIA L4")],
    });
    expect(Array.from(model.view.owners)).toEqual(["inductor"]);
    expect(model.view.highlightTotal).toBe(120);
    const gone = ownerBarsModel(HOURS, { pricer: null, trail: [o("sparse")] });
    expect(gone.view.owners.size).toBe(0);
  });

  test("$: each day at its rate, the priced days named, the unpriced hours kept apart", () => {
    const model = ownerBarsModel(OWNERS, { pricer: WEEKLY, trail: [] });
    expect(model.unit).toBe("usd");
    // Nov 11–15 priced (0.8 of each row), Nov 16–17 past the file.
    const inductor = 0.8 * (120 * 0.55 + 80 * 0.55 + 60 * 0.11);
    const distributed = 0.8 * (50 * 0.55 + 40 * 0.11);
    const dynamo = 0.8 * (100 * 0.11 + 7.4 * 0.33);
    const buckets = 0.8 * (20 * 0.11 + 5 * 0.55);
    expect(model.total.value).toBeCloseTo(
      inductor + distributed + dynamo + buckets,
      6
    );
    expect(model.total.days).toBe("5 of 7 days priced");
    expect(model.total.approx).toBe(true);
    expect(model.total.notes).toEqual(["Provisional: rates from Nov 9–13"]);
    expect(model.divisors.pricedNote).toBe("5 of 7 days priced");
    expect(model.unpricedH).toBeCloseTo(0.2 * 578 + 0.8 * (40 + 30 + 25.6), 6);
    // Ordered by $, not hours: distributed passes dynamo.
    expect(
      ownerRows(model.view, {
        expanded: false,
        bucketsOpen: false,
        ran: (owner) => (model.hours.ownerScope.get(owner) ?? 0) > 0,
      }).map((r) => r.label)
    ).toEqual(["inductor", "distributed", "dynamo", "Unattributed"]);
    // The machines keep the hours' order and hues.
    expect(model.prepared.machineOrder).toEqual(
      ownerBarsModel(HOURS, { pricer: null, trail: [] }).prepared.machineOrder
    );
  });

  test("$: an owner or machine whose hours have no rate keeps its row at $0", () => {
    const windows = only(
      OWNERS,
      (r) => r.owner !== "dynamo" || r.machine === "Windows x86_64 avx512"
    );
    const model = ownerBarsModel(windows, { pricer: WEEKLY, trail: [] });
    expect(model.view.ownerScope.get("dynamo")).toBe(0);
    const rows = ownerRows(model.view, {
      expanded: false,
      bucketsOpen: false,
      ran: (owner) => (model.hours.ownerScope.get(owner) ?? 0) > 0,
    });
    expect(rows.map((r) => [r.label, r.hours])).toContainEqual(["dynamo", 0]);
    const key = machineKeyRows(
      model.prepared,
      model.view,
      false,
      (i) => model.hours.machineScope[i] > 0
    );
    expect(key.map((r) => [r.label, r.hours])).toContainEqual([
      "Windows x86_64 avx512",
      0,
    ]);
  });

  test("$ with no day priced: no figure, read as no rates, never $0", () => {
    const later: CostOwners = {
      ...OWNERS,
      from: "2026-12-01",
      to: "2026-12-07",
      days: OWNERS.days.map((_, i) => `2026-12-0${i + 1}`),
    };
    const model = ownerBarsModel(later, { pricer: WEEKLY, trail: [] });
    expect(model.total.value).toBeNull();
    expect(model.total.blank).toBe("no rates");
    expect(model.unpricedH).toBeCloseTo(578, 6);
  });
});

describe("the keys", () => {
  function ctxOf(from: Day, to: Day, end: Day): TrendContext {
    const days: Day[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
    return {
      end,
      firstDay: days[0],
      lastFull: to,
      days: new Set(days),
      filling: new Set(),
    };
  }
  const CTX = ctxOf("2026-10-15", "2026-11-17", "2026-11-18");
  const q = (patch: Partial<TrendsQuery> = {}): TrendsQuery => ({
    rollup: "day",
    show: null,
    cmp: null,
    a: null,
    b: null,
    per: "day",
    unit: "hours",
    ...patch,
  });
  const choice = (key: string, ctx = CTX) =>
    ownerPresetChoices(ctx).find((c) => c.key === key)!;

  test("Last day, Last 3 days, Last 7 days; Trends keeps its five presets", () => {
    expect(ownerPresetChoices(CTX).map((c) => c.label)).toEqual([
      "Last day",
      "Last 3 days",
      "Last 7 days",
    ]);
    expect(COMPARE_PRESETS).toEqual(["dod", "wow", "mom", "7v7", "28v28"]);
  });

  test("Last 3 days: B ends where 7v7's B does, A the 3 days before", () => {
    expect(lastDays(3, CTX)).toEqual({
      a: { from: "2026-11-12", to: "2026-11-14" },
      b: { from: "2026-11-15", to: "2026-11-17" },
    });
    expect(choice("3d")).toMatchObject({
      available: true,
      title: "A: Nov 12 – 14 · B: Nov 15 – 17",
    });
    // While the last day fills, L is the day before, for 7v7 and 3 days.
    const filling = { ...CTX, lastFull: "2026-11-16" };
    expect(lastDays(3, filling).b).toEqual({
      from: "2026-11-14",
      to: "2026-11-16",
    });
    // Too few days: disabled, saying what it needs.
    const short = ctxOf("2026-11-13", "2026-11-17", "2026-11-18");
    expect(choice("3d", short)).toMatchObject({
      available: false,
      title: "Needs Nov 12 – Nov 17; not enough data yet",
    });
  });

  test("Last day and Last 7 days write Trends' presets; Last 3 days a custom A and B", () => {
    expect(ownerPresetPatch(choice("dod"), q({ show: 14 }), CTX)).toEqual(
      presetPatch("dod", q({ show: 14 }), CTX)
    );
    expect(ownerPresetPatch(choice("7v7"), q(), CTX)).toEqual(
      presetPatch("7v7", q(), CTX)
    );
    const days = lastDays(3, CTX);
    // In days, Show kept; from weeks, days with their default Show.
    expect(ownerPresetPatch(choice("3d"), q({ show: 14 }), CTX)).toEqual({
      rollup: "day",
      show: 14,
      cmp: null,
      ...days,
    });
    expect(
      ownerPresetPatch(choice("3d"), q({ rollup: "week", show: 26 }), CTX)
    ).toEqual({ rollup: "day", show: null, cmp: null, ...days });
  });

  test("lit while A and B are a key's days, in any rollup", () => {
    const three = resolveCompare(
      q(ownerPresetPatch(choice("3d"), q(), CTX)),
      CTX
    )!;
    expect(three).toMatchObject({ ...lastDays(3, CTX), preset: null });
    expect(ownerPresetInForce(choice("3d"), three)).toBe(true);
    expect(ownerPresetInForce(choice("7v7"), three)).toBe(false);
    const seven = resolveCompare(q({ cmp: "7v7" }), CTX)!;
    expect(ownerPresetInForce(choice("7v7"), seven)).toBe(true);
    expect(ownerPresetInForce(choice("3d"), seven)).toBe(false);
    // The day before the last in weeks: not Last day's days.
    const weeks = resolveCompare(q({ rollup: "week", cmp: "wow" }), CTX)!;
    expect(ownerPresetInForce(choice("dod"), weeks)).toBe(false);
  });
});

describe("runners", () => {
  const MODELS: [string, OwnerBarsModel][] = [
    ["hours", ownerBarsModel(HOURS, { pricer: null, trail: [] })],
    ["FAKE weekly", ownerBarsModel(OWNERS, { pricer: WEEKLY, trail: [] })],
    [
      "FAKE weekly with a gap",
      ownerBarsModel(OWNERS, { pricer: GAP, trail: [] }),
    ],
  ];
  const total = (xs: { value: number }[]) =>
    xs.reduce((a, x) => a + x.value, 0);

  test.each(MODELS)(
    "%s: a row's machines add up to the row, a machine's runners to the machine",
    (_name, model) => {
      const rows = ownerRows(model.view, {
        expanded: true,
        bucketsOpen: true,
        ran: (o) => (model.hours.ownerScope.get(o) ?? 0) > 0,
      });
      expect(rows.length).toBeGreaterThan(4);
      for (const row of rows) {
        const machines = runnerBreakdown(model, row.owners);
        expect([row.label, total(machines)]).toEqual([
          row.label,
          expect.closeTo(row.hours, 9),
        ]);
        for (const m of machines) {
          expect(total(m.runners)).toBeCloseTo(m.value, 9);
          expect(m.runners.reduce((a, r) => a + r.hours, 0)).toBeCloseTo(
            m.hours,
            9
          );
        }
      }
    }
  );

  test.each(MODELS)(
    "%s: every owner's runners add up to each machine in the key",
    (_name, model) => {
      const all = runnerBreakdown(model, null);
      for (const m of all) {
        expect(m.value).toBeCloseTo(model.view.machineScope[m.machine], 9);
        expect(m.hours).toBeCloseTo(model.hours.machineScope[m.machine], 9);
      }
      // Each runner once per machine; Unknown machine last.
      expect(all[all.length - 1].machine).toBe(model.prepared.notProbed);
    }
  );

  test("each machine's runners in a fixed order, the most runner-hours first, in shades of its paint", () => {
    const model = MODELS[1][1];
    const l4 = model.prepared.machines.indexOf("NVIDIA L4");
    expect(model.runnerOrder[l4]).toEqual([
      "mt-l-x86aavx2-11-41-l4",
      "lf-l-x86aavx2-11-41-l4",
    ]);
    for (const mode of ["light", "dark"] as const) {
      const theme = createTheme({ palette: { mode } });
      const paint = paintOf(model.prepared, l4);
      const hue = barFill(theme, model.prepared, paint);
      expect(runnerFill(theme, model.prepared, paint, 0)).toBe(
        runnerFill(theme, model.prepared, paint, -1)
      );
      expect(runnerFill(theme, model.prepared, paint, 0)).not.toBe(
        runnerFill(theme, model.prepared, paint, 1)
      );
      expect(runnerFill(theme, model.prepared, paint, 9)).toBe(
        runnerFill(theme, model.prepared, paint, 3)
      );
      expect(hue.toLowerCase()).toBe(machineHue(theme, model.prepared, l4));
      // Unknown machine keeps its stripes.
      const unknown = paintOf(model.prepared, model.prepared.notProbed);
      expect(runnerFill(theme, model.prepared, unknown, 2)).toBe(
        barFill(theme, model.prepared, unknown)
      );
    }
  });

  test("$: a runner's $/h is its $ over its priced hours, the rest unpriced; no rate without any", () => {
    const model = MODELS[1][1];
    const dynamo = runnerBreakdown(model, ["dynamo"]);
    const line = (label: string) =>
      dynamo.flatMap((m) => m.runners).find((r) => r.label === label)!;
    // Nov 11–15 at FAKE $0.11/h; Nov 16–17 past the file.
    expect(line("mt-l-x86iavx512-16-128")).toEqual({
      label: "mt-l-x86iavx512-16-128",
      hours: 100,
      unpriced: expect.closeTo(20, 9),
      value: expect.closeTo(80 * 0.11, 9),
      rate: 0.11,
      approx: false,
    });
    expect(rateText(line("mt-l-x86iavx512-16-128"))).toBe("$0.11/h");
    // A machine's $/h is an average, even where its runners share one rate.
    const avx512 = dynamo.find(
      (m) => model.prepared.machines[m.machine] === "Linux x86_64 avx512"
    )!;
    expect(avx512).toMatchObject({ rate: 0.11, approx: true });
    expect(rateText(avx512)).toBe("~$0.11/h");
    expect(line("windows.4xlarge.nonephemeral")).toMatchObject({
      hours: 30,
      unpriced: 30,
      value: 0,
      rate: null,
    });
    expect(rateText(line("windows.4xlarge.nonephemeral"))).toBe("no rate");
    // In hours, no runner has a rate.
    expect(
      runnerBreakdown(MODELS[0][1], ["dynamo"]).every(
        (m) => m.rate === null && m.unpriced === 0
      )
    ).toBe(true);
  });

  // One L4 hour on each of Nov 7–10, and a CPU label's on the same machine:
  // FAKE weekly prices Nov 2–8 and Nov 9–15 differently; the gap file
  // leaves Nov 2–8 out.
  const crossing: CostOwners = {
    ...OWNERS,
    from: "2026-11-07",
    to: "2026-11-10",
    days: ["2026-11-07", "2026-11-08", "2026-11-09", "2026-11-10"],
    filling: [],
    rows: [
      { ...OWNERS.rows[0], runner_hours: 4 },
      { ...OWNERS.rows[0], label: "mt-l-x86iavx512-16-128", runner_hours: 4 },
      { ...OWNERS.rows[7], runner_hours: 4 },
    ],
    cells: [0, 1, 2, 3].flatMap((d) =>
      [0, 1, 2].map((r) => [d, r, 1] as [number, number, number])
    ),
  };

  test("$ across rate periods: a runner whose rate changed is their average, marked ~", () => {
    const model = ownerBarsModel(crossing, { pricer: WEEKLY, trail: [] });
    const [l4] = runnerBreakdown(model, null).filter(
      (m) => model.prepared.machines[m.machine] === "NVIDIA L4"
    );
    const gpu = l4.runners.find((r) => r.label === "mt-l-x86aavx2-11-41-l4")!;
    expect(gpu.rate).toBeCloseTo((0.45 * 2 + 0.55 * 2) / 4, 9);
    expect(gpu.approx).toBe(true);
    expect(rateText(gpu)).toBe("~$0.50/h");
    // The machine averages its runners' different rates, by priced hour.
    expect(l4.approx).toBe(true);
    expect(l4.rate).toBeCloseTo(
      (0.45 * 2 + 0.55 * 2 + 0.09 * 2 + 0.11 * 2) / 8,
      9
    );
    expect(rateText(l4)).toBe("~$0.30/h");
  });

  test("$ with a gap: the gap's hours unpriced, the rest at their one rate, never a neighbour's", () => {
    const model = ownerBarsModel(crossing, { pricer: GAP, trail: [] });
    const [l4] = runnerBreakdown(model, null).filter(
      (m) => model.prepared.machines[m.machine] === "NVIDIA L4"
    );
    const gpu = l4.runners.find((r) => r.label === "mt-l-x86aavx2-11-41-l4")!;
    expect(gpu).toMatchObject({
      hours: 4,
      unpriced: 2,
      rate: 0.55,
      approx: false,
    });
    expect(gpu.value).toBeCloseTo(0.55 * 2, 9);
    expect(rateText(gpu)).toBe("$0.55/h");
    // The no-rate runner counts its priced days' hours, not the gap's.
    expect(noRateRunners(model, null)).toEqual({
      runners: [{ label: "windows.4xlarge.nonephemeral", hours: 2 }],
      hours: 2,
      of: 6,
    });
  });

  test("several machines as one: summed, $ over priced hours, no rate only where none has one", () => {
    const machines = runnerBreakdown(MODELS[1][1], ["dynamo"]);
    const all = sumFigures(machines);
    // Linux's and M1's priced hours at FAKE $0.11/h and $0.33/h; Windows'
    // no rate.
    expect(all.hours).toBeCloseTo(137.4, 9);
    expect(all.unpriced).toBeCloseTo(20 + 1.48 + 30, 9);
    expect(all.value).toBeCloseTo(80 * 0.11 + 5.92 * 0.33, 9);
    expect(all.rate).toBeCloseTo(all.value / (80 + 5.92), 9);
    expect(rateText(all)).toMatch(/^~\$/);
    const windows = machines.filter((m) => m.rate === null);
    expect(windows).toHaveLength(1);
    expect(sumFigures([...windows, ...windows])).toMatchObject({
      hours: 60,
      rate: null,
    });
    // In hours there is no rate to sum.
    expect(sumFigures(runnerBreakdown(MODELS[0][1], null)).rate).toBeNull();
  });

  test("no rate: the runners without a rate on any priced day, the most hours first, of priced days' hours", () => {
    const model = MODELS[1][1];
    const missing = noRateRunners(model, null);
    expect(missing.runners.map((r) => r.label)).toEqual([
      "amd-dpx-linux.rocm.gpu.gfx950.1",
      "windows.4xlarge.nonephemeral",
      "linux.idc.xpu",
    ]);
    expect(missing.hours).toBeCloseTo(0.8 * (40 + 30 + 25.6), 9);
    expect(missing.of).toBeCloseTo(0.8 * 578, 9);
    expect(noRateRunners(model, ["inductor"]).runners).toEqual([]);
    // In hours there is nothing to say.
    expect(noRateRunners(MODELS[0][1], null).runners).toEqual([]);
  });
});
