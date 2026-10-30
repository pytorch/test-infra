import {
  foldCell,
  queryRunGrid,
  RunGridRow,
} from "lib/api/tests/test/runs/grid";
import type { RunsGridQuery } from "lib/api/tests/test/runs/parameters";
import {
  RunGridCellSchema,
  RunGridSchema,
} from "lib/api/tests/test/runs/types";
import * as clickhouse from "lib/clickhouse";
import { ENV_VARS_ID, ENVIRONMENT_ID, TEST_ID } from "./fixtures";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const OTHER_ENVIRONMENT_ID = "18446744073709551600";
const SHARD_ONE =
  "unit-test / inductor-cpu-core-test (3.13) / test (inductor_core, 1, 2)";
const SHARD_TWO =
  "unit-test / inductor-cpu-core-test (3.13) / test (inductor_core, 2, 2)";

// One job's chain of attempts, as the grouped read returns it.
function row(overrides: Partial<RunGridRow> = {}): RunGridRow {
  return {
    commit_sha: SHA_A,
    workflow_path: ".github/workflows/pull.yml",
    environments_id_string: ENVIRONMENT_ID,
    env_vars_id_string: ENV_VARS_ID,
    job_id_string: "122957966084",
    job_url:
      "https://github.com/pytorch/pytorch/actions/runs/40726225346/job/122957966084",
    job_name: "linux-jammy-py3.11-gcc11 / test (default, 8, 10)",
    started_at: "2026-10-24T05:52:23.077Z",
    outcome: "passed",
    attempt_outcomes: ["passed"],
    duration_milliseconds: 12,
    passed_duration_milliseconds: 12,
    ...overrides,
  };
}

function catalogRow(environmentsId: string, hasEnvironment = 1) {
  return {
    requested_tests_id_string: TEST_ID,
    environments_id_string: environmentsId,
    env_vars_id_string: ENV_VARS_ID,
    has_test: 1,
    repo: "pytorch/pytorch",
    has_environment: hasEnvironment,
    has_env_vars: 1,
    environment_id_string: environmentsId,
    os: "linux",
    os_version: "22.04",
    cpu_architecture: "x86_64",
    cpu_capability: "avx512",
    python_version: "3.11",
    cc_compiler: "gcc",
    cc_compiler_version: "11.4",
    accelerator: "cpu",
    accelerator_version: "",
    device_name: "",
    device_count: 0,
    environment_first_seen_at: "2026-10-14T06:57:57.812Z",
    env_var_set_id_string: ENV_VARS_ID,
    env_vars: { TEST_CONFIG: "default" },
    env_vars_first_seen_at: "2026-10-14T06:57:57.812Z",
  };
}

const query: RunsGridQuery = {
  test_id: TEST_ID,
  group_by: "commit",
  ran_on: ["main"],
  window: "7d",
};

describe("foldCell", () => {
  // The cell that started this (test 10798099672608881194 on b8c7d2c25):
  // shard 2 hung for thirty minutes and its rerun skipped;
  // shard 1, a sibling, skipped on its own in between.
  const hungShard = row({
    job_id_string: "123062560494",
    job_name: SHARD_TWO,
    started_at: "2026-10-28T20:16:48.798Z",
    outcome: "timed_out",
    attempt_outcomes: ["timed_out", "skipped"],
    duration_milliseconds: 1801754,
    passed_duration_milliseconds: 0,
  });
  const skippingShard = row({
    job_id_string: "123062560532",
    job_name: SHARD_ONE,
    started_at: "2026-10-28T20:17:25.360Z",
    outcome: "skipped",
    attempt_outcomes: ["skipped"],
    duration_milliseconds: 0,
    passed_duration_milliseconds: 0,
  });

  test("keeps each job's chain apart and lets the worst sibling decide", () => {
    const cell = foldCell([skippingShard, hungShard]);
    expect(RunGridCellSchema.safeParse(cell).success).toBe(true);
    expect(cell).toEqual({
      commit_sha: SHA_A,
      outcome: "timed_out",
      started_at: "2026-10-28T20:16:48.798Z",
      duration_milliseconds: 1801754,
      passed_duration_milliseconds: 0,
      jobs: [
        {
          job_id: "123062560494",
          job_url: hungShard.job_url,
          job_name: SHARD_TWO,
          outcome: "timed_out",
          attempts: ["timed_out", "skipped"],
          started_at: "2026-10-28T20:16:48.798Z",
          duration_milliseconds: 1801754,
          passed_duration_milliseconds: 0,
          decisive: true,
        },
        {
          job_id: "123062560532",
          job_url: skippingShard.job_url,
          job_name: SHARD_ONE,
          outcome: "skipped",
          attempts: ["skipped"],
          started_at: "2026-10-28T20:17:25.360Z",
          duration_milliseconds: 0,
          passed_duration_milliseconds: 0,
          decisive: false,
        },
      ],
    });
  });

  test("ranks siblings: a failure that stood, a recovered pass, other, a pass, skipped", () => {
    const passing = row({
      job_id_string: "1",
      job_name: SHARD_ONE,
      started_at: "2026-10-28T10:00:00.000Z",
      passed_duration_milliseconds: 4000,
      duration_milliseconds: 4000,
    });
    const failing = row({
      job_id_string: "2",
      job_name: SHARD_TWO,
      started_at: "2026-10-28T09:00:00.000Z",
      outcome: "failed",
      attempt_outcomes: ["failed", "failed"],
      duration_milliseconds: 600,
      passed_duration_milliseconds: 0,
    });
    const recovered = row({
      job_id_string: "3",
      job_name: "test (default, 3, 3)",
      started_at: "2026-10-28T11:00:00.000Z",
      outcome: "passed",
      attempt_outcomes: ["crashed", "passed"],
      duration_milliseconds: 9000,
      passed_duration_milliseconds: 4400,
    });
    const expected = row({
      job_id_string: "4",
      job_name: "test (default, 4, 4)",
      started_at: "2026-10-28T12:00:00.000Z",
      outcome: "xfailed",
      attempt_outcomes: ["xfailed"],
      duration_milliseconds: 100,
      passed_duration_milliseconds: 0,
    });
    // A failure that stood decides over a pass, whenever it ran.
    let cell = foldCell([passing, failing]);
    expect(cell.outcome).toBe("failed");
    expect(cell.jobs.map((job) => [job.job_id, job.decisive])).toEqual([
      ["2", true],
      ["1", false],
    ]);
    // Only the passing sibling's time counts, and it is one run's.
    expect(cell.passed_duration_milliseconds).toBe(4000);
    expect(cell.duration_milliseconds).toBe(4600);
    // A pass after a failing attempt is worse than a plain pass, and both
    // passes make the time: their mean.
    cell = foldCell([passing, recovered]);
    expect(cell.outcome).toBe("passed");
    expect(cell.jobs.find((job) => job.decisive)?.job_id).toBe("3");
    expect(cell.passed_duration_milliseconds).toBe(4200);
    expect(cell.duration_milliseconds).toBe(13000);
    // An expected failure stands over a pass, a pass over a skip.
    expect(foldCell([passing, expected]).outcome).toBe("xfailed");
    expect(foldCell([passing, skippingShard]).outcome).toBe("passed");
    expect(foldCell([skippingShard, expected]).outcome).toBe("xfailed");
  });

  test("treats jobs of one name as a retry sequence, the re-run deciding", () => {
    const first = row({
      job_id_string: "10",
      job_name: SHARD_ONE,
      started_at: "2026-10-28T10:00:00.000Z",
      outcome: "failed",
      attempt_outcomes: ["failed", "failed"],
      duration_milliseconds: 600,
      passed_duration_milliseconds: 0,
    });
    const rerun = row({
      job_id_string: "11",
      job_name: SHARD_ONE,
      started_at: "2026-10-28T11:00:00.000Z",
      outcome: "passed",
      attempt_outcomes: ["passed"],
      duration_milliseconds: 4000,
      passed_duration_milliseconds: 4000,
    });
    const cell = foldCell([rerun, first]);
    // Judged as one bundle: its last executed attempt passed. The page
    // reads the sequence's attempts, failed, failed, passed, as a recovery.
    expect(cell.outcome).toBe("passed");
    expect(cell.jobs.map((job) => [job.job_id, job.decisive])).toEqual([
      ["10", false],
      ["11", true],
    ]);
    expect(cell.passed_duration_milliseconds).toBe(4000);
    expect(cell.duration_milliseconds).toBe(4600);
    // A re-run that was skipped does not recover the failure: the sequence
    // keeps the last executed attempt's outcome, and the job that decided
    // it is the one that failed, not the skipped re-run.
    const skippedRerun = foldCell([
      first,
      { ...rerun, outcome: "skipped", attempt_outcomes: ["skipped"] },
    ]);
    expect(skippedRerun.outcome).toBe("failed");
    expect(skippedRerun.jobs.find((job) => job.decisive)?.job_id).toBe("10");
    // A re-run of a job that had passed (another test failed it) passes
    // again: one run's time, the mean of the two, not their sum; the
    // re-run, the last that executed, decides. Ids order as numbers.
    const passedTwice = foldCell([
      {
        ...rerun,
        job_id_string: "10",
        started_at: "2026-10-28T11:00:00.000Z",
        passed_duration_milliseconds: 4400,
        duration_milliseconds: 4400,
      },
      { ...rerun, job_id_string: "9", started_at: "2026-10-28T10:00:00.000Z" },
    ]);
    expect(passedTwice.outcome).toBe("passed");
    expect(passedTwice.passed_duration_milliseconds).toBe(4200);
    expect(passedTwice.duration_milliseconds).toBe(8400);
    expect(passedTwice.jobs.map((job) => [job.job_id, job.decisive])).toEqual([
      ["9", false],
      ["10", true],
    ]);
    // Jobs without a name are each their own: a later unnamed pass is a
    // sibling, not a re-run, so the failure stands.
    expect(
      foldCell([
        { ...first, job_name: "" },
        { ...rerun, job_name: "" },
      ]).outcome
    ).toBe("failed");
  });

  test("breaks a tie between equal siblings by the one whose last job started last", () => {
    const earlier = row({
      job_id_string: "20",
      job_name: SHARD_ONE,
      started_at: "2026-10-28T10:00:00.000Z",
      passed_duration_milliseconds: 4000,
    });
    const later = row({
      job_id_string: "21",
      job_name: SHARD_TWO,
      started_at: "2026-10-28T10:00:00.000Z",
      passed_duration_milliseconds: 4001,
    });
    const cell = foldCell([later, earlier]);
    // The same start: the larger id, numerically, is the later job.
    expect(cell.jobs.map((job) => [job.job_id, job.decisive])).toEqual([
      ["20", false],
      ["21", true],
    ]);
    // The mean is rounded to the millisecond.
    expect(cell.passed_duration_milliseconds).toBe(4001);
  });

  test("lets the last of all-skipped siblings decide, and the later of equal others", () => {
    // Two shards that both skipped: skipped, the one that started last
    // decisive, so the click opens the latest word on the commit.
    const skips = foldCell([
      row({
        job_id_string: "1",
        job_name: SHARD_ONE,
        started_at: "2026-10-24T05:00:00.000Z",
        outcome: "skipped",
        attempt_outcomes: ["skipped"],
        duration_milliseconds: 0,
        passed_duration_milliseconds: 0,
      }),
      row({
        job_id_string: "2",
        job_name: SHARD_TWO,
        started_at: "2026-10-24T05:01:00.000Z",
        outcome: "skipped",
        attempt_outcomes: ["skipped"],
        duration_milliseconds: 0,
        passed_duration_milliseconds: 0,
      }),
    ]);
    expect(skips.outcome).toBe("skipped");
    expect(skips.jobs.map((job) => job.decisive)).toEqual([false, true]);
    // An expected failure beside an unknown rank the same; the later decides.
    const others = foldCell([
      row({
        job_id_string: "1",
        job_name: SHARD_ONE,
        started_at: "2026-10-24T05:00:00.000Z",
        outcome: "xfailed",
        attempt_outcomes: ["xfailed"],
      }),
      row({
        job_id_string: "2",
        job_name: SHARD_TWO,
        started_at: "2026-10-24T05:01:00.000Z",
        outcome: "unknown",
        attempt_outcomes: ["unknown"],
      }),
    ]);
    expect(others.outcome).toBe("unknown");
    expect(others.jobs[1].decisive).toBe(true);
  });

  test("reads a re-run that broke as failed and a recovery beside a passing sibling as a recovery", () => {
    // The same job name: a pass, then a re-run that failed, is a failure.
    const broke = foldCell([
      row({
        job_id_string: "1",
        started_at: "2026-10-24T05:00:00.000Z",
        outcome: "passed",
        attempt_outcomes: ["passed"],
      }),
      row({
        job_id_string: "2",
        started_at: "2026-10-24T06:00:00.000Z",
        outcome: "failed",
        attempt_outcomes: ["failed"],
        duration_milliseconds: 30,
        passed_duration_milliseconds: 0,
      }),
    ]);
    expect(broke.outcome).toBe("failed");
    expect(broke.passed_duration_milliseconds).toBe(0);
    expect(broke.jobs.map((job) => job.decisive)).toEqual([false, true]);
    // A job that recovered on a rerun, its re-run skipped, beside a sibling
    // that passed outright: the recovery decides (a pass after a failing
    // attempt outranks a plain pass), its recovering job is decisive, and
    // the passed time is the mean over the two sequences' passes.
    const recovered = foldCell([
      row({
        job_id_string: "1",
        job_name: SHARD_ONE,
        started_at: "2026-10-24T05:00:00.000Z",
        outcome: "passed",
        attempt_outcomes: ["failed", "passed"],
        duration_milliseconds: 500,
        passed_duration_milliseconds: 200,
      }),
      row({
        job_id_string: "2",
        job_name: SHARD_ONE,
        started_at: "2026-10-24T06:00:00.000Z",
        outcome: "skipped",
        attempt_outcomes: ["skipped"],
        duration_milliseconds: 0,
        passed_duration_milliseconds: 0,
      }),
      row({
        job_id_string: "3",
        job_name: SHARD_TWO,
        started_at: "2026-10-24T05:00:30.000Z",
        outcome: "passed",
        attempt_outcomes: ["passed"],
        duration_milliseconds: 100,
        passed_duration_milliseconds: 100,
      }),
    ]);
    expect(recovered.outcome).toBe("passed");
    expect(recovered.jobs.map((job) => [job.job_id, job.decisive])).toEqual([
      ["1", true],
      ["3", false],
      ["2", false],
    ]);
    expect(recovered.passed_duration_milliseconds).toBe(150);
    expect(recovered.duration_milliseconds).toBe(600);
    // A pass of no time is a time of zero, not nothing.
    const instant = foldCell([
      row({ duration_milliseconds: 0, passed_duration_milliseconds: 0 }),
    ]);
    expect(instant.passed_duration_milliseconds).toBe(0);
  });

  test("marks exactly one job decisive whatever the jobs' outcomes and names", () => {
    const outcomes: RunGridRow["outcome"][] = [
      "passed",
      "failed",
      "skipped",
      "xfailed",
      "timed_out",
      "unknown",
    ];
    for (const first of outcomes) {
      for (const second of outcomes) {
        for (const names of [
          [SHARD_ONE, SHARD_ONE],
          [SHARD_ONE, SHARD_TWO],
          ["", ""],
        ]) {
          const cell = foldCell([
            row({
              job_id_string: "1",
              job_name: names[0],
              started_at: "2026-10-24T05:00:00.000Z",
              outcome: first,
              attempt_outcomes: [first],
            }),
            row({
              job_id_string: "2",
              job_name: names[1],
              started_at: "2026-10-24T05:00:00.000Z",
              outcome: second,
              attempt_outcomes: [second],
            }),
          ]);
          expect(cell.jobs.filter((job) => job.decisive)).toHaveLength(1);
          expect(RunGridCellSchema.safeParse(cell).success).toBe(true);
        }
      }
    }
  });

  test("needs a job", () => {
    expect(() => foldCell([])).toThrow();
  });
});

describe("queryRunGrid", () => {
  let queryClickhouse: jest.SpyInstance;

  beforeEach(() => {
    queryClickhouse = jest.spyOn(clickhouse, "queryClickhouse");
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("shapes rows into lanes with one cell per commit and commits oldest first", async () => {
    const rows: RunGridRow[] = [
      row({
        commit_sha: SHA_B,
        job_id_string: "123062560532",
        job_name: SHARD_ONE,
        started_at: "2026-10-25T10:00:30.000Z",
        outcome: "skipped",
        attempt_outcomes: ["skipped"],
        duration_milliseconds: 0,
        passed_duration_milliseconds: 0,
      }),
      row({
        commit_sha: SHA_B,
        job_id_string: "123062560494",
        job_name: SHARD_TWO,
        started_at: "2026-10-25T10:00:00.000Z",
        outcome: "timed_out",
        attempt_outcomes: ["timed_out", "skipped"],
        duration_milliseconds: 1800000,
        passed_duration_milliseconds: 0,
      }),
      row(),
      row({
        environments_id_string: OTHER_ENVIRONMENT_ID,
        started_at: "2026-10-24T05:50:00.000Z",
        outcome: "skipped",
        attempt_outcomes: ["skipped"],
        duration_milliseconds: 0,
        passed_duration_milliseconds: 0,
        job_url: "",
        job_name: "",
      }),
    ];
    queryClickhouse.mockImplementation(async (_sql, _params, queryId) => {
      if (queryId === "api_test_runs_grid") return rows;
      if (queryId === "api_run_catalog") {
        return [
          catalogRow(ENVIRONMENT_ID),
          catalogRow(OTHER_ENVIRONMENT_ID, 0),
        ];
      }
      throw new Error(`Unexpected query: ${queryId}`);
    });

    const grid = await queryRunGrid(query, new Date("2026-10-28T18:00:00Z"));
    expect(RunGridSchema.safeParse(grid).success).toBe(true);
    // The page showing these runs: the repository from the lanes' catalog
    // rows, the window spelled, main left off as the page's default.
    expect(grid.hud_url).toBe(
      `https://hud.pytorch.org/tests/pytorch/pytorch/test/${TEST_ID}?window=7d`
    );
    expect(grid.commits).toEqual([
      { sha: SHA_A, started_at: "2026-10-24T05:50:00.000Z" },
      { sha: SHA_B, started_at: "2026-10-25T10:00:00.000Z" },
    ]);
    expect(grid.lanes).toHaveLength(2);
    // Lanes in catalog order: the same workflow, environment ids numerically.
    const [other, main] = grid.lanes;
    expect(other.environment).toBeNull();
    expect(other.env_vars?.values).toEqual({ TEST_CONFIG: "default" });
    expect(other.cells).toEqual([
      {
        commit_sha: SHA_A,
        outcome: "skipped",
        started_at: "2026-10-24T05:50:00.000Z",
        duration_milliseconds: 0,
        passed_duration_milliseconds: 0,
        jobs: [
          {
            job_id: "122957966084",
            job_url: null,
            job_name: null,
            outcome: "skipped",
            attempts: ["skipped"],
            started_at: "2026-10-24T05:50:00.000Z",
            duration_milliseconds: 0,
            passed_duration_milliseconds: 0,
            decisive: true,
          },
        ],
      },
    ]);
    expect(main.environment?.python_version).toBe("3.11");
    // Two jobs on one commit fold into one cell, the earlier first.
    expect(
      main.cells.map((cell) => [
        cell.commit_sha,
        cell.outcome,
        cell.jobs.map((job) => job.job_id),
      ])
    ).toEqual([
      [SHA_A, "passed", ["122957966084"]],
      [SHA_B, "timed_out", ["123062560494", "123062560532"]],
    ]);
    expect(main.cells[1].started_at).toBe("2026-10-25T10:00:00.000Z");
    expect(main.cells[1].jobs.map((job) => job.decisive)).toEqual([
      true,
      false,
    ]);
    expect(main.cells[1].duration_milliseconds).toBe(1800000);

    // The grid read is bound to the window start a week before now, and the
    // catalog is asked once per distinct configuration.
    const [gridCall, catalogCall] = queryClickhouse.mock.calls;
    expect(gridCall[2]).toBe("api_test_runs_grid");
    expect(gridCall[1]).toMatchObject({
      test_id: TEST_ID,
      ran_on: ["main"],
      since: Date.parse("2026-10-21T18:00:00Z"),
    });
    expect(catalogCall[2]).toBe("api_run_catalog");
    expect(catalogCall[1]).toEqual({
      tests_ids: [TEST_ID, TEST_ID],
      environments_ids: [ENVIRONMENT_ID, OTHER_ENVIRONMENT_ID],
      env_vars_ids: [ENV_VARS_ID, ENV_VARS_ID],
    });
    expect(grid.query_duration_ms).toBeGreaterThanOrEqual(0);
  });

  test("orders lanes by workflow path in code unit order, a lane without a path first", async () => {
    const rows: RunGridRow[] = [
      row({ workflow_path: ".github/workflows/inductor.yml" }),
      row({ workflow_path: ".github/workflows/Trunk.yml" }),
      row({ workflow_path: null }),
    ];
    queryClickhouse.mockImplementation(async (_sql, _params, queryId) => {
      if (queryId === "api_test_runs_grid") return rows;
      if (queryId === "api_run_catalog") return [catalogRow(ENVIRONMENT_ID)];
      throw new Error(`Unexpected query: ${queryId}`);
    });
    const grid = await queryRunGrid(query);
    // Not the locale's order, which would put Trunk.yml after inductor.yml.
    expect(grid.lanes.map((lane) => lane.workflow_path)).toEqual([
      null,
      ".github/workflows/Trunk.yml",
      ".github/workflows/inductor.yml",
    ]);
    // Three lanes of one configuration ask the catalog about it once.
    expect(queryClickhouse.mock.calls[1][1]).toEqual({
      tests_ids: [TEST_ID],
      environments_ids: [ENVIRONMENT_ID],
      env_vars_ids: [ENV_VARS_ID],
    });
    for (const lane of grid.lanes) {
      expect(lane.environment?.python_version).toBe("3.11");
    }
  });

  test("answers an empty grid without asking the catalogs", async () => {
    queryClickhouse.mockResolvedValue([]);
    const grid = await queryRunGrid(query);
    expect(grid).toEqual({
      commits: [],
      lanes: [],
      hud_url: null,
      query_duration_ms: expect.any(Number),
    });
    expect(queryClickhouse).toHaveBeenCalledTimes(1);
  });
});
