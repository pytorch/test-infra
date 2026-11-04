import type { RunnerHours } from "lib/api/tests/cost/types";
import {
  costApiUrl,
  costUrlParams,
  resolveCostQuery,
} from "lib/tests/cost/query";
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
  ownerRows,
  prepareRunnerHours,
  rowMix,
  rowsCsv,
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

const row = (
  owner: string,
  workflow: string,
  m: string,
  runner_hours: number,
  machine_source: "environment" | "runner_label" | "none" = m === ""
    ? "none"
    : "environment"
) => ({
  owner,
  workflow,
  machine: m,
  machine_source,
  runner_hours,
});

const ANSWER: RunnerHours = {
  repo: "pytorch/pytorch",
  workflow_presets: [],
  days: 14,
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
    row("shared:build", "pull", "", 90),
    row("shared:other", "lint", "", 10),
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
      14
    );
    expect(facts.scopeTotal).toBe(380);
    expect(facts.perDay).toBeCloseTo(380 / 14);
    expect(facts.annualized).toBeCloseTo((380 / 14) * 365);
    expect(facts.attributedShare).toBeCloseTo((380 - 90 - 5) / 380);
  });
});

describe("owner rows", () => {
  const view = computeView(prepared, none);

  test("top owners, the rest folded, then shared and unattributed together", () => {
    expect(
      ownerRows(view, false, "grouped", 2).map((r) => [r.label, r.hours])
    ).toEqual([
      ["inductor", 240],
      ["nn", 70],
      ["2 more owners", 48],
      ["Shared: build and other jobs", 100],
      ["Unattributed", 5],
    ]);
  });

  test("a highlighted owner keeps its row wherever it ranks; expanded lists every owner and offers fewer", () => {
    const lit = computeView(prepared, { ...none, owners: ["sparse"] });
    expect(ownerRows(lit, false, "grouped", 2).map((r) => r.key)).toEqual([
      "inductor",
      "nn",
      "sparse",
      "more",
      "shared",
      "unattributed",
    ]);
    expect(ownerRows(view, true, "each", 2).map((r) => r.key)).toEqual([
      "inductor",
      "nn",
      "fx",
      "sparse",
      "less",
      "shared:build",
      "shared:other",
      "unattributed:no_owner",
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
      csv: "owner,workflow,machine,machine_estimated,runner_hours\ninductor,pull,Linux x86_64 avx512,no,80.00\nnn,pull,Linux x86_64 avx512,no,40.00\n",
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
    expect(costApiUrl("pytorch/pytorch")).toBe(
      "/api/tests/cost?repo=pytorch%2Fpytorch"
    );
  });
});

// One machine; the unattributed buckets: test jobs without reports, on a
// label other jobs reported L4 on (estimated) and on one no job reported on
// (unknown), and test files without owners.
const ESTIMATED: RunnerHours = {
  ...ANSWER,
  rows: [
    row("inductor", "trunk", "NVIDIA L4", 10),
    row("unattributed:no_test_reports", "trunk", "NVIDIA L4", 6, "runner_label"),
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
    expect(v.machineEstimated[l4]).toBe(6);
    expect(machineKeyRows(p, v, false)[0]).toMatchObject({
      label: "NVIDIA L4",
      hours: 18,
      estimated: 6,
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
        { key: "test/test_a.py", kind: "file", hours: 0.5 },
      ],
    });
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
      "unattributed:no_test_reports,trunk,NVIDIA L4,yes,6.00"
    );
    expect(bucketInfo("unattributed:no_test_reports")).toBe(
      "No test reports: Test jobs without test reports, so their test files are unknown.\n" +
        "• Benchmarks and custom test scripts\n" +
        "• Reports not uploaded or not ingested\n" +
        "• Jobs cancelled before uploading"
    );
    expect(bucketInfo("unattributed:no_owner")).toBe(
      "No owner: Tests in files without an owner.\n" +
        "• C++ test binaries\n" +
        "• Python files not in the owners list"
    );
    expect(bucketInfo("inductor")).toBe("");
  });
});
