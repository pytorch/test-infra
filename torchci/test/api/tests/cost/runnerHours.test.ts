import { parseCostParams } from "lib/api/tests/cost/parameters";
import {
  costMachines,
  costSignals,
  getRunnerHours,
  runnerHoursRows,
  shortDeviceNames,
} from "lib/api/tests/cost/runnerHours";
import { RunnerHoursSchema } from "lib/api/tests/cost/types";
import { CI_WORKLOAD_HEAVY } from "lib/api/tests/database";
import * as clickhouse from "lib/clickhouse";

const NOW = new Date("2026-10-30T06:00:00Z");

const ROWS = [
  {
    owner: "inductor",
    workflow: "trunk",
    machine: "NVIDIA L4",
    label: "linux.g6.4xlarge",
    runner_hours: 30,
  },
  {
    owner: "inductor",
    workflow: "trunk",
    machine: "NVIDIA L4",
    label: "l-x86iavx512-8-64-l4",
    runner_hours: 10,
  },
  {
    owner: "inductor",
    workflow: "pull",
    machine: "Linux x86_64 avx512",
    label: "linux.2xlarge",
    runner_hours: 5,
  },
  {
    owner: "shared:build",
    workflow: "pull",
    machine: "",
    label: "linux.12xlarge",
    runner_hours: 50,
  },
  {
    owner: "shared:build",
    workflow: "pull",
    machine: "",
    label: "windows.4xlarge",
    runner_hours: 7,
  },
  {
    owner: "nn",
    workflow: "pull",
    machine: "NVIDIA L4",
    label: "linux.g6.4xlarge",
    runner_hours: 0,
  },
];

describe("cost runner-hours", () => {
  afterEach(() => jest.restoreAllMocks());

  test("folds runner labels away: one row per owner, workflow and machine, largest first, empty cells dropped", () => {
    expect(runnerHoursRows(ROWS)).toEqual([
      {
        owner: "shared:build",
        workflow: "pull",
        machine: "",
        runner_hours: 57,
      },
      {
        owner: "inductor",
        workflow: "trunk",
        machine: "NVIDIA L4",
        runner_hours: 40,
      },
      {
        owner: "inductor",
        workflow: "pull",
        machine: "Linux x86_64 avx512",
        runner_hours: 5,
      },
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

  test("asks the runner-hours in the heavy workload beside the machines and time to signal, and answers its schema", async () => {
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
          : [{ workflow: "trunk", runs: 3, seconds: [100, 200] }]
      );
    const answer = await getRunnerHours({ repo: "pytorch/pytorch" }, NOW);
    expect(query.mock.calls.map((call) => call[2])).toEqual([
      "tests_cost_runner_hours",
      "tests_cost_machines",
      "tests_cost_time_to_signal",
    ]);
    expect(query.mock.calls[0][1]).toEqual({
      repo: "pytorch/pytorch",
      start: "2026-10-23 00:00:00.000",
      end: "2026-10-30 00:00:00.000",
      window: "7d",
    });
    expect(query.mock.calls[0][4]).toBe(CI_WORKLOAD_HEAVY);
    expect(query.mock.calls[1][4]).toBeUndefined();
    expect(query.mock.calls[2][1]).toMatchObject({
      tts_workflows: ["pull", "trunk"],
    });
    expect(RunnerHoursSchema.safeParse(answer).success).toBe(true);
    expect([answer.days, answer.start, answer.end]).toEqual([
      7,
      "2026-10-23T00:00:00.000Z",
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
    expect(answer.rows.reduce((a, r) => a + r.runner_hours, 0)).toBe(102);
  });

  test("takes the repository, nothing else", () => {
    expect(parseCostParams({ repo: "pytorch/pytorch" })).toMatchObject({
      success: true,
      data: { repo: "pytorch/pytorch" },
    });
    expect(
      parseCostParams({ repo: "pytorch/pytorch", window: "14d" }).success
    ).toBe(false);
  });
});
