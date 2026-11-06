import type { RunnerHours } from "lib/api/tests/cost/types";
import {
  amountLabel,
  costApiUrl,
  costUrlParams,
  fineAmountLabel,
  rateLabel,
  resolveCostQuery,
  shareLabel,
} from "lib/tests/cost/query";
import {
  editedRates,
  parseRates,
  priceKey,
  priceableRunners,
  pricedRunnerHours,
  rateOf,
  ratesCoverage,
  withRate,
} from "lib/tests/cost/rates";
import {
  NOT_PROBED,
  bucketInfo,
  cellDetail,
  cellShade,
  computeView,
  factsOf,
  highlightName,
  joinNames,
  knownChoices,
  machineKeyRows,
  matrixGroups,
  ownerLabel,
  ownerRows,
  prepareRunnerHours,
  rowMix,
  rowsCsv,
  runnerBreakdown,
  scopeName,
  segments,
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

  test("facts are of the scope", () => {
    const facts = factsOf(
      prepared,
      computeView(prepared, { ...none, workflows: ["pull", "trunk"] }),
      7
    );
    expect(facts.scopeTotal).toBe(380);
    expect(facts.perDay).toBeCloseTo(380 / 7);
    expect(facts.annualized).toBeCloseTo((380 / 7) * 365);
    // A window the table holds no day of averages to nothing.
    expect(factsOf(prepared, computeView(prepared, none), 0).perDay).toBe(0);
    expect(facts.attributedShare).toBeCloseTo((380 - 90 - 5) / 380);
  });
});

describe("owner rows", () => {
  const view = computeView(prepared, none);

  test("top owners, the rest folded, then the unattributed hours together", () => {
    expect(
      ownerRows(view, false, "grouped", 2).map((r) => [r.label, r.hours])
    ).toEqual([
      ["inductor", 240],
      ["nn", 70],
      ["2 more owners", 48],
      ["Unattributed", 105],
    ]);
  });

  test("a highlighted owner keeps its row wherever it ranks; expanded lists every owner and offers fewer", () => {
    const lit = computeView(prepared, { ...none, owners: ["sparse"] });
    expect(ownerRows(lit, false, "grouped", 2).map((r) => r.key)).toEqual([
      "inductor",
      "nn",
      "sparse",
      "more",
      "unattributed",
    ]);
    expect(ownerRows(view, true, "each", 2).map((r) => r.key)).toEqual([
      "inductor",
      "nn",
      "fx",
      "sparse",
      "less",
      "unattributed:no_owner",
      "unattributed:no_test_reports",
    ]);
  });
});

describe("segments", () => {
  const view = computeView(prepared, none);
  const mix = (owner: string) =>
    view.ownerMachines.get(owner) ?? new Float64Array(0);

  test("in the fixed machine order, then other machines, then Not probed", () => {
    const all = new Float64Array(prepared.machines.length).fill(1);
    expect(
      segments(prepared, all, new Set()).map((s) => [s.label, s.paint.kind])
    ).toEqual([
      ["Linux x86_64 avx512", "machine"],
      ["NVIDIA L4", "machine"],
      ["AMD Instinct MI350X VF", "machine"],
      ["Windows x86_64 avx512", "machine"],
      ["Apple M1", "machine"],
      ["NVIDIA A10G", "machine"],
      ["Linux aarch64 sve128", "machine"],
      ["Other machines", "other"],
      [NOT_PROBED, "not_probed"],
    ]);
  });

  test("a highlighted machine without a hue takes the accent, not the others' grey", () => {
    const t4 = prepared.machines.indexOf("Tesla T4");
    expect(
      segments(prepared, mix("sparse"), new Set([t4])).map((s) => [
        s.label,
        s.paint.kind,
      ])
    ).toEqual([
      ["Tesla T4", "accent"],
      ["other machines", "pale"],
    ]);
    const view = computeView(prepared, { ...none, machines: ["Tesla T4"] });
    expect(
      machineKeyRows(prepared, view, true).find((r) => r.label === "Tesla T4")
        ?.paint.kind
    ).toBe("accent");
  });

  test("highlighted machines move to the start, the rest one pale piece", () => {
    const l4 = prepared.machines.indexOf("NVIDIA L4");
    expect(
      segments(prepared, mix("inductor"), new Set([l4])).map((s) => [
        s.label,
        s.hours,
      ])
    ).toEqual([
      ["NVIDIA L4", 100],
      ["other machines", 140],
    ]);
  });
});

describe("machine key and workflows", () => {
  test("colored machines, other machines (listed while open), Not probed; owners' hours on each", () => {
    const view = computeView(prepared, { ...none, owners: ["sparse"] });
    const rows = machineKeyRows(prepared, view, true);
    expect(rows.map((r) => [r.label, r.kind, r.hours, r.highlighted])).toEqual([
      ["Linux x86_64 avx512", "machine", 120, 0],
      ["NVIDIA L4", "machine", 105, 0],
      ["AMD Instinct MI350X VF", "machine", 60, 0],
      ["Windows x86_64 avx512", "machine", 30, 0],
      ["Apple M1", "machine", 20, 0],
      ["NVIDIA A10G", "machine", 15, 0],
      ["Linux aarch64 sve128", "machine", 12, 12],
      ["Other machines (1)", "group", 1, 1],
      ["Tesla T4", "member", 1, 1],
      [NOT_PROBED, "machine", 100, 0],
    ]);
  });

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

describe("matrix", () => {
  test("columns grouped by family, largest first, Not probed last", () => {
    const groups = matrixGroups(prepared, computeView(prepared, none));
    expect(groups.map((g) => [g.family, names(g.machines)])).toEqual([
      ["Linux CPU", ["Linux x86_64 avx512", "Linux aarch64 sve128"]],
      ["CUDA", ["NVIDIA L4", "NVIDIA A10G", "Tesla T4"]],
      ["ROCm", ["AMD Instinct MI350X VF"]],
      ["Windows CPU", ["Windows x86_64 avx512"]],
      ["MPS", ["Apple M1"]],
      [NOT_PROBED, [NOT_PROBED]],
    ]);
  });

  test("cells shade by share of machine, owner, or root of hours", () => {
    expect(cellShade("machine", 25, 100, 50, 80)).toBe(0.5);
    expect(cellShade("owner", 25, 100, 50, 80)).toBe(0.25);
    expect(cellShade("hours", 20, 100, 50, 80)).toBe(0.5);
  });

  test("a cell's workflows and owners within the scope", () => {
    const view = computeView(prepared, {
      ...none,
      workflows: ["pull", "trunk"],
    });
    const avx512 = prepared.machines.indexOf("Linux x86_64 avx512");
    expect(cellDetail(prepared, view, ["inductor", "nn"], avx512)).toEqual({
      hours: 120,
      estimated: 0,
      contributors: [],
      byWorkflow: [["pull", 120]],
      byOwner: [
        ["inductor", 80],
        ["nn", 40],
      ],
    });
  });

  test("CSV holds the rows in the scope and the highlight", () => {
    const view = computeView(prepared, {
      workflows: ["pull"],
      owners: ["inductor", "nn"],
      machines: [],
    });
    expect(rowsCsv(prepared, view)).toEqual({
      csv: "owner,workflow,machine,machine_estimated,runner_label,runner_hours\ninductor,pull,Linux x86_64 avx512,no,linux-x86_64-avx512,80.00\nnn,pull,Linux x86_64 avx512,no,linux-x86_64-avx512,40.00\n",
      rows: 2,
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

describe("cost page query", () => {
  test("a bare URL is the defaults and writes back bare", () => {
    const query = resolveCostQuery({});
    expect(query).toEqual({
      window: "7d",
      workflows: [],
      owners: [],
      machines: [],
      split: true,
      cells: "machine",
      only: false,
    });
    expect(
      Object.values(costUrlParams(query)).filter((v) => v !== undefined)
    ).toEqual([]);
  });

  test("choices round-trip; the PR preset is two workflow parameters", () => {
    const query = resolveCostQuery({
      workflow: ["pull", "Trunk"],
      owner: "inductor",
      machine: ["NVIDIA L4", NOT_PROBED],
      split_by: "none",
      cells: "hours",
      only: "1",
      organization: "pytorch",
    });
    expect(query).toMatchObject({
      workflows: ["pull", "trunk"],
      split: false,
      cells: "hours",
      only: true,
    });
    expect(resolveCostQuery(costUrlParams(query) as never)).toEqual(query);
    expect(costUrlParams(query).workflow).toEqual(["pull", "trunk"]);
    expect(resolveCostQuery({ cells: "x", only: "yes" })).toMatchObject({
      cells: "machine",
      only: false,
    });
    expect(costApiUrl("pytorch/pytorch", "3d")).toBe(
      "/api/tests/cost?repo=pytorch%2Fpytorch&window=3d"
    );
    expect(resolveCostQuery({ window: "3d" }).window).toBe("3d");
    expect(resolveCostQuery({ window: "14d" }).window).toBe("7d");
    expect(costUrlParams(resolveCostQuery({ window: "1d" })).window).toBe("1d");
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
  const unattributed = ownerRows(v, false, "grouped").find(
    (r) => r.key === "unattributed"
  );

  test("the view counts the hours whose machine came from a runner label", () => {
    expect(v.machineScope[l4]).toBe(18);
    expect(v.ownerEstimated.get("unattributed:no_test_reports")?.[l4]).toBe(6);
    expect(machineKeyRows(p, v, false)[0]).toMatchObject({
      label: "NVIDIA L4",
      hours: 18,
    });
  });

  test("a bar's machine splits into reported hours, then the estimated ones striped; unknown stays its own piece", () => {
    const owners = unattributed?.owners ?? [];
    const pieces = segments(
      p,
      rowMix(p, v, owners),
      new Set(),
      rowMix(p, v, owners, true)
    );
    expect(pieces.map((s) => [s.label, s.hours, s.paint.kind])).toEqual([
      ["NVIDIA L4", 2, "machine"],
      ["NVIDIA L4 (est.)", 6, "estimated"],
      [NOT_PROBED, 3, "not_probed"],
    ]);
  });

  test("a bucket's cell lists what it is made of, and how much has an estimated machine", () => {
    expect(
      cellDetail(p, v, ["unattributed:no_test_reports"], l4)
    ).toMatchObject({
      hours: 6,
      estimated: 6,
      contributors: [{ key: "l4.label", kind: "label", hours: 6 }],
    });
    expect(
      cellDetail(p, v, ["unattributed:no_test_reports"], p.notProbed)
        .contributors
    ).toEqual([{ key: "linux.idc.xpu", kind: "label", hours: 3 }]);
    expect(cellDetail(p, v, ["unattributed:no_owner"], l4)).toMatchObject({
      hours: 2,
      estimated: 0,
      contributors: [
        { key: "cpp/test_api", kind: "file", hours: 1.5 },
        { key: "test/test_b.py", kind: "file", hours: 1 },
        { key: "test/test_a.py", kind: "file", hours: 0.5 },
      ],
    });
    // Scoped to trunk, the pull file is out.
    const trunk = computeView(p, { ...none, workflows: ["trunk"] });
    expect(
      cellDetail(p, trunk, ["unattributed:no_owner"], l4).contributors.map(
        (c) => c.key
      )
    ).toEqual(["cpp/test_api", "test/test_a.py"]);
  });

  test("a highlighted machine keeps its estimated piece", () => {
    const owners = unattributed?.owners ?? [];
    const lit = computeView(p, { ...none, machines: ["NVIDIA L4"] });
    expect(
      segments(
        p,
        rowMix(p, lit, owners),
        lit.machines,
        rowMix(p, lit, owners, true)
      ).map((s) => [s.label, s.hours, s.paint.kind])
    ).toEqual([
      ["NVIDIA L4", 2, "machine"],
      ["NVIDIA L4 (est.)", 6, "estimated"],
      ["other machines", 3, "pale"],
    ]);
  });

  test("the matrix lists No owner before the striped No test reports", () => {
    expect(
      ownerRows(v, false, "each")
        .filter((r) => r.kind === "bucket")
        .map((r) => r.key)
    ).toEqual(["unattributed:no_owner", "unattributed:no_test_reports"]);
  });

  test("the CSV marks rows with an estimated machine; both buckets explain themselves", () => {
    expect(rowsCsv(p, v).csv).toContain(
      "unattributed:no_test_reports,trunk,NVIDIA L4,yes,nvidia-l4,6.00"
    );
    // A line naming the bucket, then what it holds as a list.
    for (const bucket of [
      "unattributed:no_owner",
      "unattributed:no_test_reports",
    ]) {
      const [first, ...items] = bucketInfo(bucket).split("\n");
      expect(first.startsWith(`${ownerLabel(bucket)}: `)).toBe(true);
      expect(items.length).toBeGreaterThan(0);
      expect(items.every((i) => i.startsWith("• "))).toBe(true);
    }
    expect(bucketInfo("inductor")).toBe("");
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
  const priced = pricedRunnerHours(prepared, RATES);
  const view = computeView(priced, none);

  test("reads a flat or wrapped object, and says what is wrong with a bad file", () => {
    expect(parseRates('{"a": 1.5, "b": 0}', "f.json")).toEqual({
      file: "f.json",
      validFrom: null,
      basis: null,
      rates: { a: 1.5, b: 0 },
      original: { a: 1.5, b: 0 },
      budget: null,
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

  test("a wrapped file may carry a budget, $ a year in all and by owner; a bad one says what is wrong", () => {
    const wrapped = (budget: unknown) =>
      JSON.stringify({ rates: { a: 1 }, budget });
    expect(
      parseRates(
        wrapped({ annual: 1_200_000, owners: { inductor: 300_000 } }),
        "f.json"
      ).budget
    ).toEqual({ annual: 1_200_000, owners: { inductor: 300_000 } });
    // Either part alone.
    expect(parseRates(wrapped({ annual: 0 }), "f.json").budget).toEqual({
      annual: 0,
      owners: {},
    });
    expect(parseRates(wrapped({ owners: { nn: 5 } }), "f.json").budget).toEqual(
      { annual: null, owners: { nn: 5 } }
    );
    expect(RATES.budget).toBeNull();
    // An edit keeps it.
    expect(
      withRate(parseRates(wrapped({ annual: 9 }), "f.json"), "a", 2).budget
    ).toEqual({ annual: 9, owners: {} });
    const error = (budget: unknown) => {
      try {
        parseRates(wrapped(budget), "f.json");
        return "";
      } catch (e) {
        return (e as Error).message;
      }
    };
    expect(error(1_000_000)).toMatch(/^budget must be \{"annual"/);
    expect(error({})).toMatch(/either part optional, but not both\.$/);
    expect(error({ annual: "1.2M" })).toBe(
      'budget.annual must be $ a year, from 0 to 10 billion: it is "1.2M".'
    );
    expect(error({ annual: -1 })).toMatch(/it is -1\.$/);
    expect(error({ owners: { nn: 1e11, fx: null } })).toBe(
      "budget.owners must be $ a year, from 0 to 10 billion: nn is 100000000000; fx is null."
    );
    // A flat file has no notes: a budget there is a runner without a rate.
    expect(() =>
      parseRates('{"a": 1, "budget": {"annual": 5}}', "f.json")
    ).toThrow(/budget is \{"annual":5\}/);
  });

  test("edits set, add and remove rates, and are listed against the file's", () => {
    const edited = withRate(
      withRate(withRate(RATES, "nvidia-l4", 2.5), "apple-m1", 0.4),
      "retired.label",
      null
    );
    expect(edited.rates).toEqual({
      "linux-x86_64-avx512": 1,
      "nvidia-l4": 2.5,
      "nvidia-a10g": 0,
      "apple-m1": 0.4,
    });
    expect(editedRates(edited).sort()).toEqual([
      "apple-m1",
      "nvidia-l4",
      "retired.label",
    ]);
    // Setting a rate back to the file's is no edit.
    expect(editedRates(withRate(edited, "nvidia-l4", 2))).not.toContain(
      "nvidia-l4"
    );
    expect(editedRates(RATES)).toEqual([]);
    // 105 h × $2.5 + 120 h × $1 + 15 h × $0 + 20 h × $0.4.
    expect(pricedRunnerHours(prepared, edited).total).toBe(390.5);
  });

  test("priceable runners: the window's price keys, largest first", () => {
    expect(priceableRunners(prepared).slice(0, 3)).toEqual([
      { label: "linux-x86_64-avx512", hours: 120 },
      { label: "nvidia-l4", hours: 105 },
      { label: "linux.12xlarge", hours: 100 },
    ]);
  });

  test("a runner's key is its label without self-hosted; 0 is a price, a missing runner has none", () => {
    expect(priceKey("linux.2xlarge")).toBe("linux.2xlarge");
    expect(priceKey("linux.2xlarge,self-hosted")).toBe("linux.2xlarge");
    expect(priceKey("a,b")).toBeNull();
    expect(rateOf(RATES, "nvidia-a10g")).toBe(0);
    expect(rateOf(RATES, "nvidia-l4,self-hosted")).toBe(2);
    expect(rateOf(RATES, "apple-m1")).toBeNull();
  });

  test("rows priced; runner-hours with no rate kept apart; machines keep their order and hues", () => {
    expect(priced.unit).toBe("cost");
    // 100 h × $2 + 80 h × $1 + 40 h × $1 + 15 h × $0 + 5 h × $2.
    expect(priced.total).toBe(330);
    expect(view.scopeTotal).toBe(330);
    expect([view.scopeRunnerHours, view.scopeUnpriced]).toEqual([463, 223]);
    expect(priced.machineOrder).toEqual(prepared.machineOrder);
    expect(priced.colored).toEqual(prepared.colored);
    expect(factsOf(priced, view, 7).attributedShare).toBeCloseTo(320 / 330);
  });

  test("owners and machines with runner-hours keep their rows at $0", () => {
    expect(
      ownerRows(view, false, "grouped").map((r) => [r.label, r.hours])
    ).toEqual([
      ["inductor", 280],
      ["nn", 40],
      ["fx", 0],
      ["sparse", 0],
      ["Unattributed", 10],
    ]);
    const mi350 = machineKeyRows(priced, view, false).find(
      (r) => r.label === "AMD Instinct MI350X VF"
    );
    expect(mi350?.hours).toBe(0);
    expect(
      view.machineUnpriced[priced.machines.indexOf("AMD Instinct MI350X VF")]
    ).toBe(60);
  });

  test("a row's machines largest first, Unknown machine last, each with its runners and rates", () => {
    expect(
      runnerBreakdown(priced, view, ["inductor"]).map((m) => [
        priced.machines[m.machine],
        m.value,
        m.hours,
        m.unpriced,
        m.runners.map((r) => [r.label, r.value, r.hours, r.rate]),
      ])
    ).toEqual([
      ["NVIDIA L4", 200, 100, 0, [["nvidia-l4", 200, 100, 2]]],
      ["Linux x86_64 avx512", 80, 80, 0, [["linux-x86_64-avx512", 80, 80, 1]]],
      [
        "AMD Instinct MI350X VF",
        0,
        60,
        60,
        [["amd-instinct-mi350x-vf", 0, 60, null]],
      ],
    ]);
    // In runner-hours, every owner's: no rates, Unknown machine last.
    const all = runnerBreakdown(prepared, computeView(prepared, none), null);
    expect(all[0]).toMatchObject({ value: 120, hours: 120 });
    expect(prepared.machines[all[all.length - 1].machine]).toBe(NOT_PROBED);
    expect(all[all.length - 1].runners).toEqual([
      { label: "linux.12xlarge", value: 100, hours: 100, rate: null },
    ]);
  });

  test("coverage: runners priced, the largest missing, entries for runners that did not run", () => {
    expect(ratesCoverage(prepared, RATES)).toEqual({
      runners: 9,
      priced: 3,
      missing: [
        { label: "linux.12xlarge", hours: 100 },
        { label: "amd-instinct-mi350x-vf", hours: 60 },
        { label: "windows-x86_64-avx512", hours: 30 },
        { label: "apple-m1", hours: 20 },
        { label: "linux-aarch64-sve128", hours: 12 },
        { label: "tesla-t4", hours: 1 },
      ],
      unused: ["retired.label"],
    });
  });

  test("amounts carry their unit", () => {
    expect(amountLabel("cost", 54100)).toBe("$54.1K");
    expect(amountLabel("hours", 740)).toBe("740 h");
    expect(amountLabel("cost", 0.2)).toBe("<$1");
    expect(amountLabel("cost", 0)).toBe("$0");
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

describe("machine runners", () => {
  // L4 on two runners, l4.b the window's larger; part of inductor's l4.b
  // hours have an estimated machine.
  const RUNNERS: RunnerHours = {
    ...ANSWER,
    rows: [
      row("inductor", "trunk", "NVIDIA L4", 30, "environment", "l4.a"),
      row("inductor", "trunk", "NVIDIA L4", 10, "environment", "l4.b"),
      row("inductor", "pull", "NVIDIA L4", 4, "runner_label", "l4.b"),
      row("inductor", "pull", "Linux x86_64 avx512", 20),
      row("nn", "trunk", "NVIDIA L4", 25, "environment", "l4.b"),
    ],
  };
  const p = prepareRunnerHours(RUNNERS);
  const l4 = p.machines.indexOf("NVIDIA L4");

  test("a machine's runners keep the window's order whatever the row", () => {
    expect(p.machineRunners[l4]).toEqual(["l4.b", "l4.a"]);
  });
});
