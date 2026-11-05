// The cost page's numbers checked against each other and against the
// example JSONs beside this file: answer.json, an answer of GET
// /api/tests/cost, and rates.json, a rates file as the cost panel takes it.
// At $1 an hour for every runner the cost is the runner-hours, to the bit,
// and at $r it is r times them; at any rates every part of the page adds up
// to one total, which is each row's runner-hours times its runner's rate
// worked out from the JSONs alone.

import { RunnerHoursSchema } from "lib/api/tests/cost/types";
import {
  averageRate,
  costFacts,
  costMark,
  missingRunners,
  parseRates,
  priceableRunners,
  pricedRunnerHours,
  ratesCoverage,
  withRate,
} from "lib/tests/cost/rates";
import {
  type CostChoices,
  type CostView,
  type PreparedHours,
  computeView,
  factsOf,
  machineKeyRows,
  NOT_PROBED,
  ownerRows,
  prepareRunnerHours,
  rowMix,
  runnerBreakdown,
  segments,
} from "lib/tests/cost/runnerHours";
import ANSWER_JSON from "./answer.json";
import RATES_JSON from "./rates.json";

const answer = RunnerHoursSchema.parse(ANSWER_JSON);
const prepared = prepareRunnerHours(answer);
const rates = parseRates(JSON.stringify(RATES_JSON), "rates.json");
const priced = pricedRunnerHours(prepared, rates);
const RUNNER_HOURS = 578;
const COST = 455.25;

// Every runner of the window at one rate.
function flat(rate: number) {
  return parseRates(
    JSON.stringify(
      Object.fromEntries(priceableRunners(prepared).map((r) => [r.label, rate]))
    ),
    "flat.json"
  );
}

const sum = (xs: Iterable<number>) => Array.from(xs).reduce((a, b) => a + b, 0);
const ofOwners = (m: Map<string, number>, owners: readonly string[]) =>
  sum(owners.map((o) => m.get(o) ?? 0));
const byName = (names: string[], values: Float64Array) =>
  Object.fromEntries(names.map((n, i) => [n, values[i]]));

// The choices a reader can make: every workflow, the PR Critical Path and
// single workflows, crossed with no highlight, an owner, a bucket, a
// machine, Unknown machine and an owner on a machine.
const SCOPES = [[], ["pull", "trunk"], ["pull"], ["inductor"], ["xpu"]];
const HIGHLIGHTS = [
  { owners: [], machines: [] },
  { owners: ["inductor"], machines: [] },
  { owners: ["unattributed:no_test_reports"], machines: [] },
  { owners: [], machines: ["NVIDIA L4"] },
  { owners: [], machines: [NOT_PROBED] },
  { owners: ["dynamo"], machines: ["Linux x86_64 avx512"] },
];
const CHOICES: CostChoices[] = SCOPES.flatMap((workflows) =>
  HIGHLIGHTS.map((h) => ({ workflows, ...h }))
);

// Each owner row's bar pieces, as the chart draws them.
function bars(p: PreparedHours, view: CostView) {
  return ownerRows(view, false, "grouped").map((row) =>
    segments(
      p,
      rowMix(p, view, row.owners),
      view.machines,
      rowMix(p, view, row.owners, true)
    )
  );
}

describe("the example answer and rates file", () => {
  test("answer.json is an answer of the API whose rows hold the window's runner-hours", () => {
    expect(sum(answer.rows.map((r) => r.runner_hours))).toBeCloseTo(
      RUNNER_HOURS,
      9
    );
    expect(prepared.total).toBeCloseTo(RUNNER_HOURS, 9);
    // Unknown machine's runner-hours are its unprobed labels'.
    expect(
      sum(
        answer.rows.filter((r) => r.machine === "").map((r) => r.runner_hours)
      )
    ).toBe(sum(answer.unprobed_labels.map((l) => l.runner_hours)));
    // Each row's label is among its machine's.
    for (const row of answer.rows.filter((r) => r.machine !== "")) {
      expect(
        answer.machines.find((m) => m.machine === row.machine)?.labels
      ).toContain(row.label);
    }
    // Each bucket's contributors are its runner-hours, by label or file.
    for (const bucket of answer.contributors.map((c) => c.bucket)) {
      expect(
        sum(
          answer.contributors
            .filter((c) => c.bucket === bucket)
            .map((c) => c.runner_hours)
        )
      ).toBeCloseTo(
        sum(
          answer.rows
            .filter((r) => r.owner === bucket)
            .map((r) => r.runner_hours)
        ),
        9
      );
    }
  });

  test("rates.json reads with its notes; two runners that ran have no rate, one rate is for a runner that did not run", () => {
    expect([rates.validFrom, rates.basis]).toEqual([
      "2026-10-01",
      "example rates for tests, not real prices",
    ]);
    expect(ratesCoverage(prepared, rates)).toEqual({
      runners: 9,
      priced: 7,
      missing: [
        { label: "mt-l-x86aavx2-11-41-a10g", hours: 80 },
        { label: "linux.idc.xpu", hours: 25.6 },
      ],
      unused: ["linux.retired.label"],
    });
  });
});

describe("$1 an hour for every runner is the runner-hours", () => {
  const one = pricedRunnerHours(prepared, flat(1));

  test("every row, workflow and machine and the total, to the bit", () => {
    expect(one.unit).toBe("cost");
    expect(one.rowHours).toEqual(prepared.rowHours);
    expect(one.rowUnpriced).toEqual(new Float64Array(answer.rows.length));
    expect(one.labelRate.every((r) => r === 1)).toBe(true);
    expect(one.total).toBe(prepared.total);
    expect(one.workflowTotal).toEqual(prepared.workflowTotal);
    expect(one.machineTotal).toEqual(prepared.machineTotal);
  });

  test.each(CHOICES)(
    "every figure of the page is its runner-hours' for %j",
    (choices) => {
      const hours = computeView(prepared, choices);
      const view = computeView(one, choices);
      // The view, and what is priced: all of it.
      for (const key of [
        "scopeTotal",
        "highlightTotal",
        "ownerScope",
        "ownerMachines",
        "ownerEstimated",
        "machineScope",
        "machineHighlighted",
        "workflowHighlighted",
        "ownerRunnerHours",
        "machineRunnerHours",
      ] as const) {
        expect(view[key]).toEqual(hours[key]);
      }
      expect(view.scopeRunnerHours).toBe(hours.scopeTotal);
      expect(view.scopeUnpriced).toBe(0);
      // The facts, the owner chart's rows and bars, and the machine key.
      expect(costFacts(one, view, answer.days)).toEqual({
        ...factsOf(prepared, hours, answer.days),
        pricedShare: 1,
      });
      expect(ownerRows(view, false, "grouped")).toEqual(
        ownerRows(hours, false, "grouped")
      );
      expect(ownerRows(view, true, "each")).toEqual(
        ownerRows(hours, true, "each")
      );
      expect(bars(one, view)).toEqual(bars(prepared, hours));
      expect(machineKeyRows(one, view, true)).toEqual(
        machineKeyRows(prepared, hours, true)
      );
      // The runners drawer and the key's runners: $ is hours at $1/h.
      const breakdown = runnerBreakdown(one, view, null);
      expect(
        breakdown.map((m) => ({
          ...m,
          runners: m.runners.map((r) => ({ ...r, rate: null })),
        }))
      ).toEqual(runnerBreakdown(prepared, hours, null));
      expect(breakdown.flatMap((m) => m.runners.map((r) => r.rate))).toEqual(
        breakdown.flatMap((m) => m.runners.map(() => 1))
      );
      expect(missingRunners(breakdown)).toEqual([]);
      // Every average is $1/h, and every bar ends at its mark.
      expect(
        averageRate(view.scopeTotal, view.scopeRunnerHours, view.scopeUnpriced)
      ).toBe(1);
      for (const m of breakdown) {
        expect(averageRate(m.value, m.hours, m.unpriced)).toBe(1);
      }
      for (const row of ownerRows(view, false, "grouped")) {
        expect(costMark(view, row.owners)).toBe(row.hours);
      }
    }
  );

  test("a job asking for two labels has no single rate, so its hours stay unpriced even at $1", () => {
    const two = prepareRunnerHours({
      ...answer,
      rows: [
        ...answer.rows,
        {
          ...answer.rows[0],
          label: "linux.g6.4xlarge.experimental.nvidia.gpu,linux.large",
          runner_hours: 22,
        },
        // self-hosted is no label of its own: priced as linux.idc.xpu.
        {
          ...answer.rows[8],
          label: "linux.idc.xpu,self-hosted",
          runner_hours: 2,
        },
      ],
    });
    const at1 = pricedRunnerHours(two, flat(1));
    const view = computeView(at1, { workflows: [], owners: [], machines: [] });
    expect(two.total).toBeCloseTo(RUNNER_HOURS + 24, 9);
    expect(at1.total).toBeCloseTo(RUNNER_HOURS + 2, 9);
    expect(view.scopeUnpriced).toBe(22);
    expect(costFacts(at1, view, 7).pricedShare).toBeCloseTo(
      (RUNNER_HOURS + 2) / (RUNNER_HOURS + 24),
      9
    );
    expect(priceableRunners(two).map((r) => r.label)).not.toContain(
      "linux.g6.4xlarge.experimental.nvidia.gpu,linux.large"
    );
  });
});

describe("$r an hour for every runner is r times the runner-hours", () => {
  test.each([0, 0.25, 1.37, 100_000])("at $%p/h", (rate) => {
    const at = pricedRunnerHours(prepared, flat(rate));
    const hours = computeView(prepared, {
      workflows: [],
      owners: [],
      machines: [],
    });
    const view = computeView(at, { workflows: [], owners: [], machines: [] });
    const close = (a: number, b: number) =>
      expect(a).toBeCloseTo(b, 9 - Math.ceil(Math.log10(rate + 1)));
    close(at.total, rate * RUNNER_HOURS);
    at.workflowTotal.forEach((v, w) =>
      close(v, rate * prepared.workflowTotal[w])
    );
    at.machineTotal.forEach((v, m) =>
      close(v, rate * prepared.machineTotal[m])
    );
    for (const [owner, h] of hours.ownerScope) {
      close(view.ownerScope.get(owner) ?? NaN, rate * h);
    }
    const facts = costFacts(at, view, answer.days);
    const hourFacts = factsOf(prepared, hours, answer.days);
    close(facts.perDay, rate * hourFacts.perDay);
    close(facts.annualized, rate * hourFacts.annualized);
    // 0 is a price: at $0 every runner-hour is priced, at $0.
    expect(facts.pricedShare).toBe(1);
    expect(
      averageRate(view.scopeTotal, view.scopeRunnerHours, view.scopeUnpriced)
    ).toBeCloseTo(rate, 9);
  });
});

describe("the example rates, worked by hand", () => {
  const view = computeView(priced, { workflows: [], owners: [], machines: [] });
  const machine = (name: string) => priced.machines.indexOf(name);

  test("each row is its runner-hours times its runner's rate, from the JSONs alone", () => {
    const table: Record<string, number> = RATES_JSON.rates;
    const expected = answer.rows.map((r) =>
      Object.hasOwn(table, r.label) ? r.runner_hours * table[r.label] : 0
    );
    expect(Array.from(priced.rowHours)).toEqual(expected);
    expect(Array.from(priced.rowUnpriced)).toEqual(
      answer.rows.map((r) =>
        Object.hasOwn(table, r.label) ? 0 : r.runner_hours
      )
    );
    // 120 h × $1.25 + 100 h × $0.5 + 60 h × $0.5 + 50 h × $1.5 + 40 h ×
    // $0.75 + 40 h × $2 + 30 h × $0.8 + 20 h × $0.5 + 7.4 h × $0 + 5 h ×
    // $1.25; A10G's 80 h and linux.idc.xpu's 25.6 h have no rate.
    expect(priced.total).toBeCloseTo(COST, 9);
    expect(view.scopeTotal).toBeCloseTo(COST, 9);
    expect(view.scopeRunnerHours).toBeCloseTo(RUNNER_HOURS, 9);
    expect(view.scopeUnpriced).toBeCloseTo(105.6, 9);
  });

  test("by owner, workflow and machine", () => {
    expect(
      ownerRows(view, false, "grouped").map((r) => [r.label, r.hours])
    ).toEqual([
      ["inductor", 180],
      ["distributed", 105],
      ["dynamo", 74],
      ["Unattributed", 96.25],
    ]);
    expect(byName(priced.workflows, priced.workflowTotal)).toEqual({
      pull: 126.25,
      inductor: 150,
      trunk: 179,
      xpu: 0,
    });
    expect(byName(priced.machines, priced.machineTotal)).toEqual({
      "Linux x86_64 avx512": 120,
      "NVIDIA L4": 231.25,
      "NVIDIA A10G": 0,
      "AMD Instinct MI355X": 80,
      "Windows x86_64 avx512": 24,
      "Apple M1": 0,
      [NOT_PROBED]: 0,
    });
  });

  test("a machine's $/h is over its priced runner-hours: mixed runners average, $0 is a rate, none is null", () => {
    const rate = (name: string) => {
      const m = runnerBreakdown(priced, view, null).find(
        (b) => b.machine === machine(name)
      );
      return m === undefined
        ? undefined
        : averageRate(m.value, m.hours, m.unpriced);
    };
    // 120 h × $1.25 + 50 h × $1.5 + 5 h × $1.25 over 175 h.
    expect(rate("NVIDIA L4")).toBeCloseTo(231.25 / 175, 12);
    expect(rate("Linux x86_64 avx512")).toBeCloseTo(120 / 220, 12);
    expect(rate("AMD Instinct MI355X")).toBe(2);
    expect(rate("Apple M1")).toBe(0);
    expect(rate("NVIDIA A10G")).toBeNull();
    expect(rate(NOT_PROBED)).toBeNull();
  });

  test("the facts: the scope's $, per day and a year, the attributed share and the share priced", () => {
    const all = costFacts(priced, view, answer.days);
    expect(all.scopeTotal).toBeCloseTo(COST, 9);
    expect(all.perDay).toBeCloseTo(COST / 7, 9);
    expect(all.annualized).toBeCloseTo((COST / 7) * 365, 9);
    expect(all.attributedShare).toBeCloseTo((180 + 105 + 74) / COST, 12);
    expect(all.pricedShare).toBeCloseTo(472.4 / RUNNER_HOURS, 12);
    // The PR Critical Path holds neither runner without a rate.
    const pr = costFacts(
      priced,
      computeView(priced, {
        workflows: ["pull", "trunk"],
        owners: [],
        machines: [],
      }),
      answer.days
    );
    expect(pr.scopeTotal).toBeCloseTo(126.25 + 179, 9);
    expect(pr.scopeShare).toBeCloseTo(305.25 / COST, 12);
    expect(pr.pricedShare).toBe(1);
  });

  test("a bar's mark is its priced runner-hours at the scope's average $/h; the marks add up to the scope's $", () => {
    const average = COST / 472.4;
    const marks = ownerRows(view, false, "grouped").map((r) => [
      r.label,
      costMark(view, r.owners),
    ]);
    expect(marks.map(([l]) => l)).toEqual([
      "inductor",
      "distributed",
      "dynamo",
      "Unattributed",
    ]);
    // inductor: 260 h, 80 of them on A10G with no rate.
    expect(marks[0][1]).toBeCloseTo(180 * average, 9);
    expect(marks[1][1]).toBeCloseTo(90 * average, 9);
    expect(marks[2][1]).toBeCloseTo(137.4 * average, 9);
    // 20 h without an owner, 45 of the 70.6 h without reports.
    expect(marks[3][1]).toBeCloseTo(65 * average, 9);
    expect(sum(marks.map(([, m]) => m as number))).toBeCloseTo(COST, 9);
    // Nothing priced, no mark.
    const none = computeView(
      pricedRunnerHours(prepared, parseRates('{"x": 1}', "x.json")),
      {
        workflows: [],
        owners: [],
        machines: [],
      }
    );
    expect(costMark(none, ["inductor"])).toBe(0);
  });

  test("the runners with no rate, largest first, are the runner-hours unpriced", () => {
    const all = runnerBreakdown(priced, view, null);
    expect(missingRunners(all)).toEqual([
      { label: "mt-l-x86aavx2-11-41-a10g", hours: 80 },
      { label: "linux.idc.xpu", hours: 25.6 },
    ]);
    expect(missingRunners(runnerBreakdown(priced, view, ["inductor"]))).toEqual(
      [{ label: "mt-l-x86aavx2-11-41-a10g", hours: 80 }]
    );
    expect(missingRunners(runnerBreakdown(priced, view, ["dynamo"]))).toEqual(
      []
    );
  });

  test("an edit reprices by the change times the runner's runner-hours", () => {
    const a10g = withRate(rates, "mt-l-x86aavx2-11-41-a10g", 1);
    expect(pricedRunnerHours(prepared, a10g).total).toBeCloseTo(COST + 80, 9);
    // Removed, mt-l-x86aavx2-11-41-l4's 125 h at $1.25 leave the cost.
    const l4 = withRate(rates, "mt-l-x86aavx2-11-41-l4", null);
    const at = computeView(pricedRunnerHours(prepared, l4), {
      workflows: [],
      owners: [],
      machines: [],
    });
    expect(at.scopeTotal).toBeCloseTo(COST - 125 * 1.25, 9);
    expect(at.scopeUnpriced).toBeCloseTo(105.6 + 125, 9);
    // A runner that did not run changes nothing.
    expect(
      pricedRunnerHours(prepared, withRate(rates, "linux.retired.label", 10))
        .total
    ).toBe(priced.total);
  });
});

describe("every view adds up, at the example rates and in runner-hours", () => {
  const cases = CHOICES.flatMap((choices) => [
    { unit: "cost", p: priced, choices },
    { unit: "hours", p: prepared, choices },
  ]);

  test.each(cases)("$unit, $choices", ({ p, choices }) => {
    const view = computeView(p, choices);
    const hours = computeView(prepared, choices);
    const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 9);
    close(sum(p.workflowTotal), p.total);
    close(sum(p.machineTotal), p.total);
    close(sum(view.machineScope), view.scopeTotal);
    close(sum(view.ownerScope.values()), view.scopeTotal);
    // What is priced and what is not make up the scope's runner-hours.
    close(view.scopeRunnerHours, hours.scopeTotal);
    expect(view.ownerRunnerHours).toEqual(hours.ownerScope);
    expect(view.machineRunnerHours).toEqual(hours.machineScope);
    for (const [owner, h] of view.ownerRunnerHours) {
      expect(view.ownerUnpriced.get(owner)).toBeLessThanOrEqual(h);
    }
    // The owner chart's rows, folded or listed, are the scope.
    close(
      sum(ownerRows(view, false, "grouped").map((r) => r.hours)),
      view.scopeTotal
    );
    close(
      sum(
        ownerRows(view, true, "each")
          .filter((r) => r.kind !== "less")
          .map((r) => r.hours)
      ),
      view.scopeTotal
    );
    // Each bar's pieces are its row.
    const rows = ownerRows(view, false, "grouped");
    bars(p, view).forEach((pieces, i) =>
      close(sum(pieces.map((s) => s.hours)), rows[i].hours)
    );
    // The machine key's rows, folded, are the scope; open, its members are
    // the group's.
    close(
      sum(machineKeyRows(p, view, false).map((r) => r.hours)),
      view.scopeTotal
    );
    const open = machineKeyRows(p, view, true);
    const group = open.find((r) => r.kind === "group");
    if (group !== undefined) {
      close(
        sum(open.filter((r) => r.kind === "member").map((r) => r.hours)),
        group.hours
      );
    }
    // The runners drawer and the key's runners: machines make up the scope,
    // runners their machine, and the runners with no rate what is unpriced.
    const breakdown = runnerBreakdown(p, view, null);
    close(sum(breakdown.map((m) => m.value)), view.scopeTotal);
    close(sum(breakdown.map((m) => m.hours)), view.scopeRunnerHours);
    close(sum(breakdown.map((m) => m.unpriced)), view.scopeUnpriced);
    for (const m of breakdown) {
      close(sum(m.runners.map((r) => r.value)), m.value);
      close(sum(m.runners.map((r) => r.hours)), m.hours);
    }
    if (p.unit === "cost") {
      close(
        sum(missingRunners(breakdown).map((r) => r.hours)),
        view.scopeUnpriced
      );
      close(
        sum(
          ownerRows(view, false, "grouped").map((r) => costMark(view, r.owners))
        ),
        view.scopeTotal
      );
    }
    // A highlighted owner's runners are its row.
    for (const owner of view.owners) {
      close(
        sum(runnerBreakdown(p, view, [owner]).map((m) => m.value)),
        ofOwners(view.ownerScope, [owner])
      );
    }
    const facts = costFacts(p, view, answer.days);
    close(facts.pricedShare, 1 - view.scopeUnpriced / view.scopeRunnerHours);
    close(facts.perDay * answer.days, view.scopeTotal);
  });
});
