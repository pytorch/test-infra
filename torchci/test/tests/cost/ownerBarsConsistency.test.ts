// The owner bars and the drill read B alike: one synthetic set of
// runner-hours (B = Nov 5–18, Nov 10 without data, quarter hours, priced
// and unpriced labels, both buckets, machines from reports, from labels and
// none) as /owners (piece=day) and as /scope at the root (by=o, by=m, piece
// day) would answer it, for every workflow and the PR Critical Path. B's
// total (with its priced-days note and ≈), each owner's figure and each
// machine's equal the drill's, in hours and with FAKE rates whose periods
// change on Nov 9 and end on Nov 15 (and whose Nov 2–8 is a gap).

import {
  addDays,
  type CostOwners,
  type CostScope,
  type Day,
  NO_OWNER,
  NO_TEST_REPORTS,
  type Pricer,
  UNKNOWN_MACHINE,
} from "lib/api/tests/cost/contracts";
import { levelFigures, sideTotal } from "lib/tests/cost/drill";
import { ownerBarsModel } from "lib/tests/cost/ownerBars";
import { makePricer, parseRatesFiles } from "lib/tests/cost/ratePeriods";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface Rec {
  day: Day;
  owner: string;
  workflow: string;
  machine: string;
  source: "environment" | "runner_label" | "none";
  label: string;
  h: number;
}

const B = { from: "2026-11-05", to: "2026-11-18" };
const A = { from: "2026-10-22", to: "2026-11-04" };
const DAYS: Day[] = [];
for (let d = B.from; d <= B.to; d = addDays(d, 1)) {
  if (d !== "2026-11-10") DAYS.push(d);
}
const L4 = "lf-l-x86aavx2-11-41-l4";
const AVX = "mt-l-x86iavx512-16-128";
const TEMPLATES: Omit<Rec, "day" | "h">[] = [
  {
    owner: "inductor",
    workflow: "pull",
    machine: "NVIDIA L4",
    source: "environment",
    label: L4,
  },
  {
    owner: "inductor",
    workflow: "periodic",
    machine: "Linux x86_64 avx512",
    source: "environment",
    label: AVX,
  },
  {
    owner: "dynamo",
    workflow: "trunk",
    machine: "Linux x86_64 avx512",
    source: "environment",
    label: AVX,
  },
  {
    owner: "dynamo",
    workflow: "trunk",
    machine: "Windows x86_64 avx512",
    source: "environment",
    label: "windows.4xlarge.nonephemeral",
  },
  {
    owner: NO_OWNER,
    workflow: "pull",
    machine: "Linux x86_64 avx512",
    source: "environment",
    label: AVX,
  },
  {
    owner: NO_TEST_REPORTS,
    workflow: "pull",
    machine: "NVIDIA L4",
    source: "runner_label",
    label: L4,
  },
  {
    owner: NO_TEST_REPORTS,
    workflow: "periodic",
    machine: "",
    source: "none",
    label: "linux.idc.xpu",
  },
];
const RECORDS: Rec[] = DAYS.flatMap((day, d) =>
  TEMPLATES.map((t, i) => ({
    ...t,
    day,
    h: 0.25 * (((d * 7 + i * 3) % 9) + 1),
  }))
);

function index<T>(names: T[], name: T): number {
  const at = names.indexOf(name);
  if (at >= 0) return at;
  names.push(name);
  return names.length - 1;
}

// /owners' answer for a workflow scope: rows over B, cells by day.
function ownersOf(workflows: string[]): CostOwners {
  const recs = RECORDS.filter(
    (r) => workflows.length === 0 || workflows.includes(r.workflow)
  );
  const keys: string[] = [];
  const rows: CostOwners["rows"] = [];
  const cells: CostOwners["cells"] = [];
  for (const r of recs) {
    const key = JSON.stringify([
      r.owner,
      r.workflow,
      r.machine,
      r.source,
      r.label,
    ]);
    const at = index(keys, key);
    if (rows[at] === undefined) {
      rows[at] = {
        owner: r.owner,
        workflow: r.workflow,
        machine: r.machine,
        machine_source: r.source,
        label: r.label,
        runner_hours: 0,
      };
    }
    rows[at].runner_hours += r.h;
    cells.push([DAYS.indexOf(r.day), at, r.h]);
  }
  return {
    repo: "pytorch/pytorch",
    workflows,
    ...B,
    piece: "day",
    days: DAYS,
    filling: [],
    rows,
    machines: ["NVIDIA L4", "Linux x86_64 avx512", "Windows x86_64 avx512"].map(
      (machine) => ({ machine, family: "", short: machine, labels: [] })
    ),
    unprobed_labels: [{ label: "linux.idc.xpu", runner_hours: 1 }],
    cells,
    method: "",
    query_duration_ms: 1,
  };
}

// /scope's answer at the root for a workflow scope, by owner or machine,
// with day pieces; A holds no days.
function scopeOf(workflows: string[], by: "o" | "m"): CostScope {
  const recs = RECORDS.filter(
    (r) => workflows.length === 0 || workflows.includes(r.workflow)
  );
  const children: string[] = [];
  const labels: string[] = [];
  const cells: CostScope["cells"] = [];
  for (const r of recs) {
    const child =
      by === "o" ? r.owner : r.machine === "" ? UNKNOWN_MACHINE : r.machine;
    cells.push([
      1,
      DAYS.indexOf(r.day),
      index(children, child),
      index(labels, r.label),
      r.h,
      0,
    ]);
  }
  return {
    repo: "pytorch/pytorch",
    workflows,
    trail: [],
    by,
    a: A,
    b: B,
    piece: "day",
    sides: [
      { days: [], pushes: [], filling: [] },
      { days: DAYS, pushes: DAYS.map(() => 0), filling: [] },
    ],
    pieces: DAYS.map((day) => ({ side: 1 as const, from: day, to: day })),
    children,
    info: children.map(() => ({})),
    labels,
    cells,
    tests: [],
    query_duration_ms: 1,
  };
}

const pricerOf = (...names: string[]) =>
  makePricer(
    parseRatesFiles(
      names.map((name) => ({
        name,
        text: readFileSync(join(__dirname, name), "utf8"),
      }))
    )
  );
const PRICERS: [string, Pricer | null][] = [
  ["hours", null],
  [
    "FAKE weekly",
    pricerOf("rates_FAKE_weekly.json", "rates_FAKE_weekly.meta.json"),
  ],
  ["FAKE weekly with a gap", pricerOf("rates_FAKE_weekly_gap.json")],
];

describe.each([
  ["every workflow", [] as string[]],
  ["the PR Critical Path", ["pull", "trunk"]],
])("%s", (_name, workflows) => {
  test.each(PRICERS)(
    "%s: B's total, each owner and each machine as the drill reads them",
    (_p, pricer) => {
      const unit = pricer === null ? "hours" : "usd";
      const model = ownerBarsModel(ownersOf(workflows), { pricer, trail: [] });
      const byOwner = scopeOf(workflows, "o");
      const drill = levelFigures(byOwner, pricer);
      const head = sideTotal(drill.total[1], drill.divisors[1], unit);
      expect(model.total.value).not.toBeNull();
      expect(model.total.value as number).toBeCloseTo(head.value as number, 9);
      expect(model.total.days).toBe(head.days);
      expect(model.total.approx).toBe(head.approx);
      expect(model.total.notes).toEqual(head.notes);
      if (pricer !== null) {
        expect(model.unpricedH).toBeCloseTo(drill.total[1].unpricedH, 9);
        // The files end on Nov 15: B is never fully priced.
        expect(head.days).toMatch(/of 13 days priced$/);
      }
      const figure = (f: { h: number; usd: number }) =>
        unit === "usd" ? f.usd : f.h;
      byOwner.children.forEach((owner, c) => {
        expect([owner, model.view.ownerScope.get(owner) ?? 0]).toEqual([
          owner,
          expect.closeTo(figure(drill.children[c][1]), 9),
        ]);
      });
      const byMachine = scopeOf(workflows, "m");
      const machines = levelFigures(byMachine, pricer);
      byMachine.children.forEach((machine, c) => {
        const m = model.prepared.machines.indexOf(machine);
        expect(m).toBeGreaterThanOrEqual(0);
        expect([machine, model.view.machineScope[m]]).toEqual([
          machine,
          expect.closeTo(figure(machines.children[c][1]), 9),
        ]);
      });
    }
  );
});
