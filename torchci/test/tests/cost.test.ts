import type { RunnerHours } from "lib/api/tests/cost/types";
import {
  amountLabel,
  fineAmountLabel,
  rateLabel,
  shareLabel,
} from "lib/tests/cost/query";
import { parseRates, priceKey, rateOf } from "lib/tests/cost/rates";
import {
  NOT_PROBED,
  computeView,
  highlightName,
  joinNames,
  knownChoices,
  prepareRunnerHours,
  scopeName,
  toggled,
  workflowRows,
} from "lib/tests/cost/runnerHours";

const machine = (
  name: string,
  family: RunnerHours["machines"][number]["family"],
  short: string
) => ({
  machine: name,
  family,
  short,
  labels: [`${short}.label`],
});

// Eight probed machines, so one falls outside the seven hues, and Not probed.
const MACHINES = [
  machine("Linux x86_64 avx512", "Linux CPU", "x86_64 avx512"),
  machine("NVIDIA L4", "CUDA", "L4"),
  machine("AMD Instinct MI350X VF", "ROCm", "AMD Instinct MI350X VF"),
  machine("Windows x86_64 avx512", "Windows CPU", "x86_64 avx512"),
  machine("Apple M1", "MPS", "Apple M1"),
  machine("NVIDIA A10G", "CUDA", "A10G"),
  machine("Linux aarch64 sve128", "Linux CPU", "aarch64 sve128"),
  machine("Tesla T4", "CUDA", "Tesla T4"),
];

// Each machine's runner label, one per machine; the unknown machine's hours
// ran on linux.12xlarge.
const labelOf = (m: string) =>
  m === "" ? "linux.12xlarge" : m.toLowerCase().replace(/ /g, "-");

const row = (
  owner: string,
  workflow: string,
  m: string,
  runner_hours: number,
  machine_source: "environment" | "runner_label" | "none" = m === ""
    ? "none"
    : "environment",
  label = labelOf(m)
) => ({
  owner,
  workflow,
  machine: m,
  machine_source,
  label,
  runner_hours,
});

const ANSWER: RunnerHours = {
  repo: "pytorch/pytorch",
  window: "7d",
  workflow_presets: [],
  days: 7,
  start: "2026-10-18T00:00:00.000Z",
  end: "2026-11-01T00:00:00.000Z",
  rows: [
    row("inductor", "trunk", "NVIDIA L4", 100),
    row("inductor", "pull", "Linux x86_64 avx512", 80),
    row("inductor", "inductor", "AMD Instinct MI350X VF", 60),
    row("nn", "pull", "Linux x86_64 avx512", 40),
    row("nn", "trunk", "Windows x86_64 avx512", 30),
    row("fx", "pull", "Apple M1", 20),
    row("fx", "pull", "NVIDIA A10G", 15),
    row("sparse", "periodic", "Linux aarch64 sve128", 12),
    row("sparse", "periodic", "Tesla T4", 1),
    row("unattributed:no_test_reports", "pull", "", 90),
    row("unattributed:no_test_reports", "lint", "", 10),
    row("unattributed:no_owner", "trunk", "NVIDIA L4", 5),
  ],
  machines: MACHINES,
  contributors: [],
  unprobed_labels: [{ label: "linux.12xlarge", runner_hours: 100 }],
  time_to_signal: [],
  method: "",
  query_duration_ms: 1,
};

const prepared = prepareRunnerHours(ANSWER);
const none = { workflows: [], owners: [], machines: [] };
const names = (ms: number[]) => ms.map((m) => prepared.machines[m]);

describe("prepared runner-hours", () => {
  test("workflows largest first; machines largest first with Not probed last; seven hues in name order", () => {
    expect(prepared.workflows).toEqual([
      "pull",
      "trunk",
      "inductor",
      "periodic",
      "lint",
    ]);
    expect(prepared.total).toBe(463);
    expect(names(prepared.machineOrder)).toEqual([
      "Linux x86_64 avx512",
      "NVIDIA L4",
      "AMD Instinct MI350X VF",
      "Windows x86_64 avx512",
      "Apple M1",
      "NVIDIA A10G",
      "Linux aarch64 sve128",
      "Tesla T4",
      NOT_PROBED,
    ]);
    expect(names(prepared.colored)).toEqual([
      "AMD Instinct MI350X VF",
      "Apple M1",
      "Linux aarch64 sve128",
      "Linux x86_64 avx512",
      "NVIDIA A10G",
      "NVIDIA L4",
      "Windows x86_64 avx512",
    ]);
    expect(prepared.family[prepared.notProbed]).toBe(NOT_PROBED);
    expect(prepared.labels[prepared.notProbed]).toEqual(["linux.12xlarge"]);
  });

  test("names the answer does not hold are dropped", () => {
    expect(
      knownChoices(prepared, {
        workflows: ["pull", "gone"],
        owners: ["nobody"],
        machines: [NOT_PROBED],
      })
    ).toEqual({ workflows: ["pull"], owners: [], machines: [NOT_PROBED] });
  });
});

describe("view", () => {
  test("the scope changes the totals; a highlight does not", () => {
    const all = computeView(prepared, none);
    const pr = computeView(prepared, { ...none, workflows: ["pull", "trunk"] });
    const lit = computeView(prepared, {
      workflows: ["pull", "trunk"],
      owners: ["inductor"],
      machines: ["NVIDIA L4"],
    });
    expect([all.scopeTotal, pr.scopeTotal, lit.scopeTotal]).toEqual([
      463, 380, 380,
    ]);
    expect(lit.highlightTotal).toBe(100);
    expect(lit.ownerScope).toEqual(pr.ownerScope);
    // The workflows card reads highlighted hours over the whole window.
    expect(
      lit.workflowHighlighted[prepared.workflows.indexOf("inductor")]
    ).toBe(0);
    const owner = computeView(prepared, { ...none, owners: ["inductor"] });
    expect(
      owner.workflowHighlighted[prepared.workflows.indexOf("inductor")]
    ).toBe(60);
    expect(scopeName(prepared, pr)).toBe("pull + trunk");
    expect(highlightName(prepared, lit)).toBe("inductor on NVIDIA L4");
  });
});

describe("workflows", () => {
  test("the top workflows with ticked ones pinned; expanded, the search narrows", () => {
    const view = computeView(prepared, { ...none, workflows: ["lint"] });
    expect(workflowRows(prepared, view, false, "", 2)).toEqual({
      shown: [0, 1, 4],
      hidden: 2,
    });
    expect(workflowRows(prepared, view, true, "per", 2)).toEqual({
      shown: [3, 4],
      hidden: 3,
    });
  });
});

describe("helpers", () => {
  test("joins names and toggles selections", () => {
    expect(joinNames(["a", "b", "c", "d"])).toBe("a + b + 2 more");
    expect(toggled(["a", "b"], ["b"])).toEqual(["a"]);
    expect(toggled(["a"], ["b", "c"])).toEqual(["a", "b", "c"]);
    expect(toggled(["a", "b"], ["a", "b"])).toEqual([]);
  });
});

// One machine; the unattributed buckets: test jobs without reports, on a
// label other jobs reported L4 on (estimated) and on one no job reported on
// (unknown), and test files without owners.
const ESTIMATED: RunnerHours = {
  ...ANSWER,
  rows: [
    row("inductor", "trunk", "NVIDIA L4", 10),
    row(
      "unattributed:no_test_reports",
      "trunk",
      "NVIDIA L4",
      6,
      "runner_label"
    ),
    row("unattributed:no_owner", "trunk", "NVIDIA L4", 2),
    row("unattributed:no_test_reports", "trunk", "", 3),
  ],
  machines: [machine("NVIDIA L4", "CUDA", "L4")],
  contributors: [
    {
      bucket: "unattributed:no_test_reports",
      workflow: "trunk",
      machine: "NVIDIA L4",
      kind: "label",
      key: "l4.label",
      runner_hours: 6,
    },
    {
      bucket: "unattributed:no_test_reports",
      workflow: "trunk",
      machine: "",
      kind: "label",
      key: "linux.idc.xpu",
      runner_hours: 3,
    },
    {
      bucket: "unattributed:no_owner",
      workflow: "trunk",
      machine: "NVIDIA L4",
      kind: "file",
      key: "cpp/test_api",
      runner_hours: 1.5,
    },
    {
      bucket: "unattributed:no_owner",
      workflow: "trunk",
      machine: "NVIDIA L4",
      kind: "file",
      key: "test/test_a.py",
      runner_hours: 0.5,
    },
    // A workflow with no rows in this answer: outside any scope.
    {
      bucket: "unattributed:no_owner",
      workflow: "pull",
      machine: "NVIDIA L4",
      kind: "file",
      key: "test/test_b.py",
      runner_hours: 1,
    },
  ],
  unprobed_labels: [{ label: "linux.idc.xpu", runner_hours: 3 }],
};

describe("estimated machines and the unattributed buckets", () => {
  const p = prepareRunnerHours(ESTIMATED);
  const v = computeView(p, none);
  const l4 = p.machines.indexOf("NVIDIA L4");

  test("the view counts the hours whose machine came from a runner label", () => {
    expect(v.machineScope[l4]).toBe(18);
    expect(v.ownerEstimated.get("unattributed:no_test_reports")?.[l4]).toBe(6);
  });
});

describe("cost from a rates file", () => {
  // Linux avx512 at $1/h, L4 at $2/h, A10G free; the rest have no rate, and
  // one entry is for a runner that did not run.
  const RATES = parseRates(
    JSON.stringify({
      valid_from: "2026-10-01",
      basis: "made up",
      rates: {
        "linux-x86_64-avx512": 1,
        "nvidia-l4": 2,
        "nvidia-a10g": 0,
        "retired.label": 5,
      },
    }),
    "rates.json"
  );

  test("reads a flat or wrapped object, and says what is wrong with a bad file", () => {
    expect(parseRates('{"a": 1.5, "b": 0}', "f.json")).toEqual({
      file: "f.json",
      validFrom: null,
      basis: null,
      window: null,
      rates: { a: 1.5, b: 0 },
    });
    expect([RATES.validFrom, RATES.basis]).toEqual(["2026-10-01", "made up"]);
    const error = (text: string) => {
      try {
        parseRates(text, "f.json");
        return "";
      } catch (e) {
        return (e as Error).message;
      }
    };
    expect(error("{")).toMatch(/^f\.json is not valid JSON/);
    expect(error("[1]")).toMatch(/^Expected a JSON object/);
    expect(error('{"a": "1,20", "b": -1, "c": 2}')).toBe(
      'Rates must be numbers from 0 to 100,000, like 1.23: a is "1,20"; b is -1.'
    );
    // Near the float limit every total would be infinite.
    expect(error('{"a": 1e308}')).toMatch(/a is 1e\+308/);
    // A flat file's notes are not rates.
    expect(error('{"valid_from": "2026-10-01", "a": 1}')).toMatch(
      /valid_from is "2026-10-01"/
    );
    expect(error("{}")).toBe("f.json has no rates.");
  });

  test("a wrapped file's usage window: its first and last days, in order; anything else is ignored and the file still prices", () => {
    const read = (window: unknown) =>
      parseRates(JSON.stringify({ window, rates: { a: 1 } }), "f.json");
    const windowOf = (window: unknown) => read(window).window;
    // Other keys, such as the generator's day count, are ignored.
    expect(
      windowOf({ start: "2026-10-08", end: "2026-11-06", days: 30 })
    ).toEqual({ start: "2026-10-08", end: "2026-11-06" });
    // Both days are included, so one day is a window.
    expect(windowOf({ start: "2026-11-06", end: "2026-11-06" })).toEqual({
      start: "2026-11-06",
      end: "2026-11-06",
    });
    expect(windowOf({ start: "2028-02-29", end: "2028-03-01" })).toEqual({
      start: "2028-02-29",
      end: "2028-03-01",
    });
    for (const bad of [
      { start: "2026-11-06", end: "2026-10-08" },
      { start: "2026-02-30", end: "2026-03-01" },
      { start: "2026-12-01", end: "2026-13-01" },
      { start: "2027-02-29", end: "2027-03-01" },
      { start: "0000-01-01", end: "2026-01-01" },
      { start: "2026-1-01", end: "2026-01-02" },
      { start: "2026-10-08T00:00:00Z", end: "2026-11-06" },
      { start: "2026-10-08\n", end: "2026-11-06" },
      { start: 20261008, end: 20261106 },
      { start: "2026-10-08" },
      ["2026-10-08", "2026-11-06"],
      "2026-10-08 to 2026-11-06",
      null,
    ]) {
      expect(windowOf(bad)).toBeNull();
      expect(read(bad).rates).toEqual({ a: 1 });
    }
    expect(read(undefined).window).toBeNull();
    // A flat file has no notes: a window there is a bad rate, as valid_from is.
    expect(() =>
      parseRates(
        JSON.stringify({ window: { start: "2026-10-08", end: "2026-11-06" } }),
        "f.json"
      )
    ).toThrow(/window is \{"start":"2026-10-08","end":"2026-11-06"\}/);
  });

  test("a runner's key is its label without self-hosted; 0 is a price, a missing runner has none", () => {
    expect(priceKey("linux.2xlarge")).toBe("linux.2xlarge");
    expect(priceKey("linux.2xlarge,self-hosted")).toBe("linux.2xlarge");
    expect(priceKey("a,b")).toBeNull();
    expect(rateOf(RATES, "nvidia-a10g")).toBe(0);
    expect(rateOf(RATES, "nvidia-l4,self-hosted")).toBe(2);
    expect(rateOf(RATES, "apple-m1")).toBeNull();
  });

  test("amounts carry their unit", () => {
    expect(amountLabel("cost", 54100)).toBe("$54.1K");
    expect(amountLabel("hours", 740)).toBe("740 h");
    expect(amountLabel("cost", 0.2)).toBe("<$1");
    expect(amountLabel("cost", 0)).toBe("$0");
    // Millions keep 3 significant figures.
    expect(amountLabel("hours", 1_043_733.8)).toBe("1.04M h");
    expect(amountLabel("hours", 13_970_000)).toBe("14M h");
    expect(amountLabel("hours", 18_240_000)).toBe("18.2M h");
    expect(amountLabel("cost", 201_200)).toBe("$201.2K");
  });

  test("fineAmountLabel: cents and tenths under 10, whole amounts without them", () => {
    expect(fineAmountLabel("cost", 0.375)).toBe("$0.38");
    expect(fineAmountLabel("cost", 2.5)).toBe("$2.50");
    expect(fineAmountLabel("cost", 8)).toBe("$8");
    expect(fineAmountLabel("cost", 0.001)).toBe("<$0.01");
    expect(fineAmountLabel("cost", 12.4)).toBe("$12");
    expect(fineAmountLabel("hours", 0.44)).toBe("0.4 h");
    expect(fineAmountLabel("hours", 4)).toBe("4 h");
    expect(fineAmountLabel("hours", 0.01)).toBe("<0.1 h");
    expect(fineAmountLabel("hours", 0)).toBe("0 h");
    expect(fineAmountLabel("hours", -2.5)).toBe("-2.5 h");
  });

  test("rates read to 3 significant figures under $1, so an edit never reads as the rate it changed", () => {
    expect(rateLabel(0.6467)).toBe("$0.647/h");
    expect(rateLabel(0.65)).toBe("$0.65/h");
    expect(rateLabel(0.5)).toBe("$0.50/h");
    expect(rateLabel(0.05)).toBe("$0.05/h");
    expect(rateLabel(1.234)).toBe("$1.23/h");
    expect(rateLabel(0)).toBe("$0.00/h");
  });

  test("a share is never none or the whole when it is neither", () => {
    expect(shareLabel(0.004)).toBe("<1%");
    expect(shareLabel(0.996)).toBe(">99%");
    expect(shareLabel(1)).toBe("100%");
    expect(shareLabel(0.5)).toBe("50%");
  });
});
