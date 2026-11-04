import { parseCostParams } from "lib/api/tests/cost/parameters";
import {
  costContributors,
  costMachines,
  costSignals,
  coveredWindow,
  getRunnerHours,
  runnerHoursRows,
  shortDeviceNames,
} from "lib/api/tests/cost/runnerHours";
import { RunnerHoursSchema } from "lib/api/tests/cost/types";
import * as clickhouse from "lib/clickhouse";

const NOW = new Date("2026-10-30T06:00:00Z");

// A row of the runner-hours query.
const q = (
  owner: string,
  workflow: string,
  machine: string,
  machine_source: "environment" | "runner_label" | "none",
  label: string,
  runner_hours: number,
  file = ""
) => ({ owner, workflow, machine, machine_source, label, file, runner_hours });

const ROWS = [
  q("inductor", "trunk", "NVIDIA L4", "environment", "linux.g6.4xlarge", 30),
  q(
    "inductor",
    "trunk",
    "NVIDIA L4",
    "environment",
    "l-x86iavx512-8-64-l4",
    10
  ),
  q(
    "inductor",
    "pull",
    "Linux x86_64 avx512",
    "environment",
    "linux.2xlarge",
    5
  ),
  q("unattributed:no_test_reports", "pull", "", "none", "linux.12xlarge", 50),
  q("unattributed:no_test_reports", "pull", "", "none", "windows.4xlarge", 7),
  q("nn", "pull", "NVIDIA L4", "environment", "linux.g6.4xlarge", 0),
  // A test job without reports whose label other jobs reported L4 on.
  q(
    "unattributed:no_test_reports",
    "inductor",
    "NVIDIA L4",
    "runner_label",
    "linux.g6.4xlarge",
    4
  ),
  // One file without owners, on two labels.
  q(
    "unattributed:no_owner",
    "trunk",
    "NVIDIA L4",
    "environment",
    "linux.g6.4xlarge",
    2,
    "cpp/test_api"
  ),
  q(
    "unattributed:no_owner",
    "trunk",
    "NVIDIA L4",
    "environment",
    "l-x86iavx512-8-64-l4",
    1,
    "cpp/test_api"
  ),
];

describe("cost runner-hours", () => {
  afterEach(() => jest.restoreAllMocks());

  test("folds runner labels and files away: one row per owner, workflow, machine and machine source, largest first, empty cells dropped", () => {
    const row = (
      owner: string,
      workflow: string,
      machine: string,
      machine_source: string,
      runner_hours: number
    ) => ({ owner, workflow, machine, machine_source, runner_hours });
    expect(runnerHoursRows(ROWS)).toEqual([
      row("unattributed:no_test_reports", "pull", "", "none", 57),
      row("inductor", "trunk", "NVIDIA L4", "environment", 40),
      row("inductor", "pull", "Linux x86_64 avx512", "environment", 5),
      row(
        "unattributed:no_test_reports",
        "inductor",
        "NVIDIA L4",
        "runner_label",
        4
      ),
      row("unattributed:no_owner", "trunk", "NVIDIA L4", "environment", 3),
    ]);
  });

  test("the unattributed buckets by runner label (no test reports) and test file (no owner), largest first", () => {
    const c = (
      bucket: string,
      workflow: string,
      machine: string,
      kind: string,
      key: string,
      runner_hours: number
    ) => ({ bucket, workflow, machine, kind, key, runner_hours });
    expect(costContributors(ROWS)).toEqual([
      c(
        "unattributed:no_test_reports",
        "pull",
        "",
        "label",
        "linux.12xlarge",
        50
      ),
      c(
        "unattributed:no_test_reports",
        "pull",
        "",
        "label",
        "windows.4xlarge",
        7
      ),
      c(
        "unattributed:no_test_reports",
        "inductor",
        "NVIDIA L4",
        "label",
        "linux.g6.4xlarge",
        4
      ),
      c(
        "unattributed:no_owner",
        "trunk",
        "NVIDIA L4",
        "file",
        "cpp/test_api",
        3
      ),
    ]);
  });

  test("machines largest first, with their families, short names and labels; Not probed is not a machine", () => {
    const machines = costMachines(ROWS, [
      {
        machine: "NVIDIA L4",
        family: "CUDA",
        device: "NVIDIA L4",
        cpu: "x86_64 avx2",
      },
      {
        machine: "Linux x86_64 avx512",
        family: "Linux CPU",
        device: "",
        cpu: "x86_64 avx512",
      },
    ]);
    expect(machines).toEqual([
      // Alone in its family, the device keeps its whole name.
      {
        machine: "NVIDIA L4",
        family: "CUDA",
        short: "NVIDIA L4",
        labels: ["linux.g6.4xlarge", "l-x86iavx512-8-64-l4"],
      },
      {
        machine: "Linux x86_64 avx512",
        family: "Linux CPU",
        short: "x86_64 avx512",
        labels: ["linux.2xlarge"],
      },
    ]);
    // A machine without details is its own family, under its own name.
    expect(costMachines(ROWS.slice(0, 1), [])[0]).toMatchObject({
      family: "NVIDIA L4",
      short: "NVIDIA L4",
    });
  });

  test("devices drop the leading words other devices of their family share, with no list of vendors", () => {
    const short = shortDeviceNames([
      "NVIDIA L4",
      "NVIDIA H100 80GB HBM3",
      "Tesla T4",
      "AMD Instinct MI350X VF",
      "AMD Instinct MI300X",
      "AMD Radeon RX 7900 XT",
      "Apple M2",
      "Apple M2 Pro",
    ]);
    expect(Object.fromEntries(short)).toEqual({
      "NVIDIA L4": "L4",
      "NVIDIA H100 80GB HBM3": "H100 80GB HBM3",
      "Tesla T4": "Tesla T4",
      "AMD Instinct MI350X VF": "MI350X VF",
      "AMD Instinct MI300X": "MI300X",
      "AMD Radeon RX 7900 XT": "Radeon RX 7900 XT",
      "Apple M2": "M2",
      "Apple M2 Pro": "M2 Pro",
    });
  });

  test("the PR update and merge signals from their workflows' runs, in order; none without runs", () => {
    const signals = costSignals([
      { workflow: "trunk", runs: 387, seconds: [14384, 16611] },
      { workflow: "docs-build", runs: 9, seconds: [1, 2] },
    ]);
    expect(
      signals.map((s) => [
        s.label,
        s.workflow,
        s.runs,
        s.p50_seconds,
        s.p90_seconds,
      ])
    ).toEqual([
      ["PR update signals", "pull", 0, null, null],
      ["PR merge signals", "trunk", 387, 14384, 16611],
    ]);
  });

  test("asks the runner-hours, machines, time to signal and coverage, none heavy, and answers its schema", async () => {
    const query = jest
      .spyOn(clickhouse, "queryClickhouse")
      .mockImplementation(async (_sql, _params, id) =>
        id === "tests_cost_runner_hours"
          ? ROWS
          : id === "tests_cost_machines"
          ? [
              {
                machine: "NVIDIA L4",
                family: "CUDA",
                device: "NVIDIA L4",
                cpu: "x86_64 avx2",
              },
            ]
          : id === "tests_cost_coverage"
          ? // The rollup holds 3 of the window's 7 days.
            [{ days: 3, first_day: "2026-10-27" }]
          : [{ workflow: "trunk", runs: 3, seconds: [100, 200] }]
      );
    const answer = await getRunnerHours(
      { repo: "pytorch/pytorch", window: "7d" },
      NOW
    );
    expect(query.mock.calls.map((call) => call[2])).toEqual([
      "tests_cost_runner_hours",
      "tests_cost_machines",
      "tests_cost_time_to_signal",
      "tests_cost_coverage",
    ]);
    expect(query.mock.calls[0][1]).toEqual({
      repo: "pytorch/pytorch",
      start: "2026-10-23 00:00:00.000",
      end: "2026-10-30 00:00:00.000",
    });
    // About 0.3 CPU-seconds: not a heavy query.
    expect(query.mock.calls.map((call) => call[4])).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(query.mock.calls[3][1]).toEqual(query.mock.calls[0][1]);
    expect(query.mock.calls[2][1]).toMatchObject({
      tts_workflows: ["pull", "trunk"],
    });
    expect(RunnerHoursSchema.safeParse(answer).success).toBe(true);
    // 3 of the 7 days have data: the average divides by 3.
    expect([answer.window, answer.days, answer.start, answer.end]).toEqual([
      "7d",
      3,
      "2026-10-27T00:00:00.000Z",
      "2026-10-30T00:00:00.000Z",
    ]);
    expect(answer.workflow_presets).toEqual([
      expect.objectContaining({
        label: "PR Critical Path",
        workflows: ["pull", "trunk"],
      }),
    ]);
    expect(answer.unprobed_labels).toEqual([
      { label: "linux.12xlarge", runner_hours: 50 },
      { label: "windows.4xlarge", runner_hours: 7 },
    ]);
    expect(answer.rows.reduce((a, r) => a + r.runner_hours, 0)).toBe(109);
    expect(answer.contributors.map((c) => c.key)).toEqual([
      "linux.12xlarge",
      "windows.4xlarge",
      "linux.g6.4xlarge",
      "cpp/test_api",
    ]);
  });

  test("takes the repository and a window of 1, 3 or 7 days, 7 by default", () => {
    expect(parseCostParams({ repo: "pytorch/pytorch" })).toMatchObject({
      success: true,
      data: { repo: "pytorch/pytorch", window: "7d" },
    });
    expect(
      parseCostParams({ repo: "pytorch/pytorch", window: "3d" })
    ).toMatchObject({ success: true, data: { window: "3d" } });
    expect(
      parseCostParams({ repo: "pytorch/pytorch", window: "14d" }).success
    ).toBe(false);
  });

  test("a window's days with data, and the first of them; none is 0 days from the window's start", () => {
    const bounds = {
      start: "2026-10-23T00:00:00.000Z",
      end: "2026-10-30T00:00:00.000Z",
    };
    expect(coveredWindow(bounds, { days: 7, first_day: "2026-10-23" })).toEqual(
      { start: bounds.start, days: 7 }
    );
    // A missing day inside the window counts out of the average.
    expect(coveredWindow(bounds, { days: 5, first_day: "2026-10-25" })).toEqual(
      { start: "2026-10-25T00:00:00.000Z", days: 5 }
    );
    // An empty window: min(day) of no rows is 1970-01-01, and days 0.
    expect(coveredWindow(bounds, { days: 0, first_day: "1970-01-01" })).toEqual(
      { start: bounds.start, days: 0 }
    );
    expect(coveredWindow(bounds, undefined)).toEqual({
      start: bounds.start,
      days: 0,
    });
  });
});
