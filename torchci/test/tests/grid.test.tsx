// The grid of a test's runs on the test page: how the API's grid is read
// into lanes and groups, how a cell and a lane read, how the lanes are
// labelled, where the days change, how columns fit a width, where the
// table's rows and columns go, how the header's choices come from the URL
// and go back into it, and how the hook asks for the grid.

import type { TestOptions } from "lib/api/tests/options/types";
import type {
  RunGrid,
  RunGridCell,
  RunGridJob,
  RunGridLane,
} from "lib/api/tests/test/runs/types";
import type { EnvironmentRecord, EnvVarsRecord } from "lib/api/tests/types";
import {
  attemptSplit,
  attemptStatus,
  badgeLabel,
  cardJobs,
  CELL_STATUSES,
  cellHeadline,
  cellParts,
  cellRadius,
  cellStatus,
  cellTime,
  changeLabel,
  columnCommits,
  columnLayout,
  commitSearch,
  commitSearchMessage,
  dayMarks,
  decisiveAttempts,
  decisiveJob,
  decisiveSequence,
  DEFAULT_GRID_RAN_ON,
  DEFAULT_GRID_WINDOW,
  edgedBox,
  estimatedBadgeWidth,
  estimatedLabelWidth,
  estimatedTextWidth,
  filterGroups,
  foldedLaneHeight,
  footerHeight,
  gridColumns,
  gridGroups,
  gridRows,
  gridUrlParams,
  headerDescriptions,
  labelLayout,
  laneHeightFor,
  laneLines,
  lanePinned,
  laneStatus,
  laneTimes,
  MIN_CELL_WIDTH,
  outcomesLabel,
  outcomesPhrase,
  outcomeSwatchStatus,
  panelPath,
  passedEventually,
  resolveGridQuery,
  splitBoxes,
  stretchAtColumn,
  stretches,
  stretchLabel,
  stretchTone,
  testGridApiUrl,
  TIME_FLOOR_MS,
  timeBarAvailable,
  timeBarShown,
  UNKNOWN_WORKFLOW,
} from "lib/tests/grid";
import { useTestGrid } from "lib/tests/useTestGrid";
import { act, create, ReactTestRenderer } from "react-test-renderer";
import { SWRConfig } from "swr";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

function environment(
  overrides: Partial<EnvironmentRecord> = {}
): EnvironmentRecord {
  return {
    id: "1",
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
    first_seen_at: "2026-10-14T06:57:57.812Z",
    ...overrides,
  };
}

function envVars(values: Record<string, string>): EnvVarsRecord {
  return { id: "2", values, first_seen_at: "2026-10-14T06:57:57.812Z" };
}

// One job's chain of attempts, its outcome the bundle rule's (the last
// executed attempt's, or skipped), decisive unless said otherwise.
function job(
  attempts: RunGridCell["outcome"][],
  overrides: Partial<RunGridJob> = {}
): RunGridJob {
  return {
    job_id: "7",
    job_url: "https://github.com/x/y/actions/runs/1/job/7",
    job_name: "test (default, 1, 2)",
    outcome:
      [...attempts].reverse().find((attempt) => attempt !== "skipped") ??
      "skipped",
    attempts,
    started_at: "2026-10-24T05:52:23.077Z",
    // Every executed attempt 1.2 s, so a run that passed on a retry carries
    // 2.4 s in all and 1.2 s of passing.
    duration_milliseconds:
      1200 * attempts.filter((attempt) => attempt !== "skipped").length,
    passed_duration_milliseconds:
      1200 * attempts.filter((attempt) => attempt === "passed").length,
    decisive: true,
    ...overrides,
  };
}

// A cell of several jobs, its times as the API folds them: the passed time
// the mean over the jobs that passed, the duration the whole.
function cellOf(
  sha: string,
  outcome: RunGridCell["outcome"],
  jobs: RunGridJob[]
): RunGridCell {
  const passed = jobs.filter((each) => each.outcome === "passed");
  return {
    commit_sha: sha,
    outcome,
    started_at: jobs[0].started_at,
    duration_milliseconds: jobs.reduce(
      (sum, each) => sum + each.duration_milliseconds,
      0
    ),
    passed_duration_milliseconds:
      passed.length === 0
        ? 0
        : Math.round(
            passed.reduce(
              (sum, each) => sum + each.passed_duration_milliseconds,
              0
            ) / passed.length
          ),
    jobs,
  };
}

// A cell of one job, the usual: the cell's outcome is the job's.
function cell(
  sha: string,
  started_at: string,
  outcome: RunGridCell["outcome"],
  attempts: RunGridCell["outcome"][] = [outcome]
): RunGridCell {
  return {
    ...cellOf(sha, outcome, [job(attempts, { outcome, started_at })]),
    started_at,
  };
}

function lane(
  workflow_path: string | null,
  cells: RunGridCell[],
  overrides: Partial<RunGridLane> = {}
): RunGridLane {
  return {
    workflow_path,
    environment: environment(),
    env_vars: envVars({ TEST_CONFIG: "default" }),
    cells,
    ...overrides,
  };
}

const options = {
  ran_on: {
    default: ["main"],
    values: [
      { value: "main", label: "main" },
      { value: "pull_request", label: "pull requests" },
    ],
  },
  window: {
    default: "12h",
    values: [
      { value: "3h", label: "3 hours" },
      { value: "3d", label: "3 days" },
      { value: "7d", label: "7 days" },
      { value: "14d", label: "14 days" },
    ],
  },
} as unknown as TestOptions;

describe("cellStatus and its words", () => {
  test("reads the final outcome and the attempts before it", () => {
    expect(cellStatus(cell(SHA_A, "", "passed"))).toBe("passed");
    expect(cellStatus(cell(SHA_A, "", "passed", ["failed", "passed"]))).toBe(
      "flaky"
    );
    expect(
      cellStatus(cell(SHA_A, "", "timed_out", ["timed_out", "skipped"]))
    ).toBe("failed");
    expect(cellStatus(cell(SHA_A, "", "error"))).toBe("failed");
    expect(cellStatus(cell(SHA_A, "", "skipped"))).toBe("skipped");
    expect(cellStatus(cell(SHA_A, "", "xfailed"))).toBe("other");
  });

  test("headlines a recovered run as flaky and any other by its outcome", () => {
    expect(cellHeadline(cell(SHA_A, "", "passed", ["failed", "passed"]))).toBe(
      "Flaky"
    );
    expect(
      cellHeadline(cell(SHA_A, "", "timed_out", ["timed_out", "skipped"]))
    ).toBe("Timed out");
    expect(cellHeadline(cell(SHA_A, "", "xpassed"))).toBe("Unexpected pass");
  });

  test("splits a run whose first attempt ended differently from how it ended", () => {
    const split = (
      outcome: RunGridCell["outcome"],
      attempts: RunGridCell["outcome"][]
    ) => attemptSplit(cell(SHA_A, "", outcome, attempts));
    expect(split("passed", ["passed"])).toBeNull();
    // The usual flake: red above the flaky yellow.
    expect(split("passed", ["crashed", "passed"])).toEqual({
      first: "failed",
      last: "flaky",
    });
    expect(split("passed", ["failed", "failed", "passed"])).toEqual({
      first: "failed",
      last: "flaky",
    });
    // An expected failure, then a pass (a rule test: the launcher reruns
    // failures alone): plain above green.
    expect(split("passed", ["xfailed", "passed"])).toEqual({
      first: "other",
      last: "passed",
    });
    // Attempts that ended differently without changing how the run ended
    // are one pill (a timeout whose rerun was skipped had been
    // red over red): a skip never overrides an
    // executed attempt, so the run ended as its first attempt did.
    expect(split("timed_out", ["timed_out", "skipped"])).toBeNull();
    expect(split("timed_out", ["timed_out", "skipped", "skipped"])).toBeNull();
    expect(split("passed", ["passed", "skipped"])).toBeNull();
    // Attempts that all ended the same way: a failure retried and failed
    // again, a run that passed twice, a run skipped twice.
    expect(split("failed", ["failed", "failed"])).toBeNull();
    expect(split("passed", ["passed", "passed"])).toBeNull();
    expect(split("skipped", ["skipped", "skipped"])).toBeNull();
    // The two capsules share the cell's box less the 2px gap between them.
    const outer = { x: 10, y: 20, width: 24, height: 12 };
    expect(splitBoxes(outer)).toEqual({
      first: { x: 10, y: 20, width: 24, height: 5 },
      last: { x: 10, y: 27, width: 24, height: 5 },
    });
    expect(
      cellParts(cell(SHA_A, "", "passed", ["crashed", "passed"]), outer)
    ).toEqual([
      { box: { x: 10, y: 20, width: 24, height: 5 }, status: "failed" },
      { box: { x: 10, y: 27, width: 24, height: 5 }, status: "flaky" },
    ]);
    expect(
      cellParts(cell(SHA_A, "", "failed", ["failed", "failed"]), outer)
    ).toEqual([{ box: outer, status: "failed" }]);
  });

  test("judges a cell by the jobs that decided it, never by a sibling shard's run", () => {
    // The cell that showed it: shard 2 hung for thirty
    // minutes and its rerun skipped; shard 1, a sibling, skipped on its own
    // between the two. The deciding sequence is shard 2 alone, so the cell
    // is one red pill headed Timed out, the sibling's skip no part of the
    // chain.
    const hung = job(["timed_out", "skipped"], {
      job_id: "494",
      job_name: "test (inductor_core, 2, 2)",
      started_at: "2026-10-28T20:16:48.798Z",
    });
    const sibling = job(["skipped"], {
      job_id: "532",
      job_name: "test (inductor_core, 1, 2)",
      started_at: "2026-10-28T20:17:25.360Z",
      decisive: false,
    });
    const twoShards = cellOf(SHA_A, "timed_out", [hung, sibling]);
    expect(decisiveJob(twoShards)).toBe(hung);
    expect(decisiveSequence(twoShards)).toEqual([hung]);
    expect(decisiveAttempts(twoShards)).toEqual(["timed_out", "skipped"]);
    expect(cellStatus(twoShards)).toBe("failed");
    expect(cellHeadline(twoShards)).toBe("Timed out");
    expect(attemptSplit(twoShards)).toBeNull();
    // The card lists the deciding jobs first, whenever they started.
    expect(
      cardJobs(cellOf(SHA_A, "timed_out", [sibling, hung])).map(
        (each) => each.job_id
      )
    ).toEqual(["494", "532"]);
    // Two shards that disagree: the failure decides and the cell is one
    // red pill; the other shard's pass is no first attempt of this one.
    const passedShard = job(["passed"], {
      job_id: "1",
      job_name: "test (default, 1, 2)",
      decisive: false,
    });
    const failedShard = job(["failed"], {
      job_id: "2",
      job_name: "test (default, 2, 2)",
    });
    const disagree = cellOf(SHA_A, "failed", [passedShard, failedShard]);
    expect(cellStatus(disagree)).toBe("failed");
    expect(attemptSplit(disagree)).toBeNull();
    expect(passedEventually(disagree)).toBe(false);
    // A job and its re-run share a name and make one sequence: the failures
    // then the pass are a recovery, red over yellow, timed by the pass.
    const first = job(["failed", "failed"], {
      job_id: "10",
      job_name: "test (default, 1, 2)",
      decisive: false,
    });
    const rerun = job(["passed"], {
      job_id: "11",
      job_name: "test (default, 1, 2)",
      started_at: "2026-10-24T07:00:00.000Z",
    });
    const recovered = cellOf(SHA_A, "passed", [first, rerun]);
    expect(decisiveSequence(recovered)).toEqual([first, rerun]);
    expect(decisiveAttempts(recovered)).toEqual(["failed", "failed", "passed"]);
    expect(cellStatus(recovered)).toBe("flaky");
    expect(attemptSplit(recovered)).toEqual({
      first: "failed",
      last: "flaky",
    });
    expect(cellTime(recovered)).toBe(1200);
    expect(recovered.duration_milliseconds).toBe(3600);
    // A job without a name is a sequence of its own.
    const unnamed = job(["failed"], { job_id: "20", job_name: null });
    const unnamedToo = job(["passed"], {
      job_id: "21",
      job_name: null,
      decisive: false,
    });
    expect(
      decisiveSequence(cellOf(SHA_A, "failed", [unnamed, unnamedToo]))
    ).toEqual([unnamed]);
    // Should no job be marked, the last stands in.
    expect(
      decisiveJob({ jobs: [{ ...unnamed, decisive: false }, unnamedToo] })
    ).toBe(unnamedToo);
  });

  test("times a cell by its pass, else by the jobs that decided it", () => {
    // A pass is timed by the API's passed time, the mean over the jobs that
    // passed: two shards at 4.0 s and 4.4 s are one run of 4.2 s, the 8.4 s
    // spent in all kept apart.
    const quick = job(["passed"], {
      job_id: "1",
      job_name: "test (default, 1, 2)",
      duration_milliseconds: 4000,
      passed_duration_milliseconds: 4000,
      decisive: false,
    });
    const slow = job(["passed"], {
      job_id: "2",
      job_name: "test (default, 2, 2)",
      duration_milliseconds: 4400,
      passed_duration_milliseconds: 4400,
    });
    const bothPassed = cellOf(SHA_A, "passed", [quick, slow]);
    expect(bothPassed.passed_duration_milliseconds).toBe(4200);
    expect(cellTime(bothPassed)).toBe(4200);
    expect(bothPassed.duration_milliseconds).toBe(8400);
    // A failure is timed by the deciding jobs alone: the hung shard's thirty
    // minutes, not the passing sibling's seconds too.
    const hung = job(["timed_out", "skipped"], {
      job_id: "3",
      job_name: "test (default, 2, 2)",
      duration_milliseconds: 1800000,
      passed_duration_milliseconds: 0,
    });
    const hungBeside = cellOf(SHA_A, "timed_out", [quick, hung]);
    expect(cellTime(hungBeside)).toBe(1800000);
    expect(hungBeside.duration_milliseconds).toBe(1804000);
    expect(cellTime(cell(SHA_A, "", "skipped"))).toBe(0);
  });

  test("reads each attempt's outcome as a status for its pill", () => {
    expect(
      (
        [
          "passed",
          "failed",
          "error",
          "crashed",
          "timed_out",
          "skipped",
        ] as const
      ).map(attemptStatus)
    ).toEqual(["passed", "failed", "failed", "failed", "failed", "skipped"]);
    expect(
      (["xfailed", "xpassed", "unknown"] as const).map(attemptStatus)
    ).toEqual(["other", "other", "other"]);
  });
});

describe("laneStatus", () => {
  test("follows the health view's rule", () => {
    expect(laneStatus([])).toBe("skipped");
    expect(laneStatus([cell(SHA_A, "", "skipped")])).toBe("skipped");
    expect(
      laneStatus([cell(SHA_A, "", "skipped"), cell(SHA_B, "", "passed")])
    ).toBe("healthy");
    expect(
      laneStatus([
        cell(SHA_A, "", "passed", ["failed", "passed"]),
        cell(SHA_B, "", "passed"),
      ])
    ).toBe("flaky");
    expect(
      laneStatus([
        cell(SHA_A, "", "passed", ["failed", "passed"]),
        cell(SHA_B, "", "failed"),
      ])
    ).toBe("failing");
  });
});

describe("laneLines", () => {
  test("leads with the config and what torch ran on, the platform beneath", () => {
    // As the list page's cells: the config, then the accelerator and the
    // device; the Python, the OS, the CPU and the compiler on the second
    // line, in the catalog's spelling without options.
    expect(laneLines(lane(null, []), undefined)).toEqual({
      tokens: ["default", "cpu"],
      details: ["Python 3.11", "linux 22.04", "x86_64 avx512", "gcc 11.4"],
    });
    expect(
      laneLines(
        lane(null, [], {
          environment: environment({
            accelerator: "cuda",
            accelerator_version: "13.2",
            device_name: "NVIDIA L4",
            device_count: 1,
          }),
        }),
        undefined
      ).tokens
    ).toEqual(["default", "cuda 13.2", "NVIDIA L4"]);
    // The variables besides the config are not tokens: the badge counts
    // them and the expanded lane lists them, in full and in name order.
    const slow = lane(null, [], {
      env_vars: envVars({
        TEST_CONFIG: "slow",
        PYTORCH_TEST_WITH_SLOW: "1",
        PYTORCH_TEST_SKIP_FAST: "1",
      }),
    });
    expect(laneLines(slow, undefined).tokens).toEqual(["slow", "cpu"]);
    const [group] = gridGroups({
      commits: [],
      lanes: [slow],
      hud_url: null,
      query_duration_ms: 1,
    });
    expect(group.lanes[0].variables).toEqual([
      "PYTORCH_TEST_SKIP_FAST=1",
      "PYTORCH_TEST_WITH_SLOW=1",
    ]);
  });

  test("draws the panel with a square corner under the tab", () => {
    // Rounded at 9px but for the top-right corner, where the badge joins.
    expect(panelPath({ x: 18, y: 136, width: 371, height: 54 }, 9)).toBe(
      "M27,136 H389 V181 Q389,190 380,190 H27 Q18,190 18,181 V145 Q18,136 27,136 Z"
    );
    // The radius pulls in for a panel too small for it.
    expect(panelPath({ x: 0, y: 0, width: 40, height: 10 }, 9)).toBe(
      "M5,0 H40 V5 Q40,10 35,10 H5 Q0,10 0,5 V5 Q0,0 5,0 Z"
    );
  });

  test("counts the variables in a badge that opens into a panel", () => {
    expect(badgeLabel(1)).toBe("+1 var");
    expect(badgeLabel(3)).toBe("+3 vars");
    // The badge's text at 6.4px a character plus 6px padding a side.
    expect(estimatedBadgeWidth(3)).toBe(estimatedTextWidth("+3 vars") + 12);
    const variables = ["PYTORCH_TEST_WITH_SLOW=1", "PYTORCH_TEST_SKIP_FAST=1"];
    const passed = new Map([[SHA_A, cell(SHA_A, "", "passed")]]);
    const skipped = new Map([[SHA_A, cell(SHA_A, "", "skipped")]]);
    const twoLines = { cells: passed, details: ["Python 3.11"], variables };
    const oneLine = { cells: skipped, details: [], variables };
    const bare = { cells: skipped, details: [], variables: [] };
    // Folded: two lines of label make a 40px lane, time bar or not; one
    // line with a badge 26px, so the badge has air; one line alone 20px.
    expect(foldedLaneHeight(twoLines)).toBe(40);
    expect(foldedLaneHeight(oneLine)).toBe(26);
    expect(foldedLaneHeight(bare)).toBe(20);
    // A pass makes a 40px lane, time bar or not: the time line under the
    // counts needs the second line.
    expect(foldedLaneHeight({ ...bare, cells: passed })).toBe(40);
    // The two lines sit centred, the badge on the second, 18px tall; open,
    // the panel hangs from the badge's bottom with 6px of padding around
    // a 14px line per variable, and 6px of air end the lane.
    const folded = labelLayout({ top: 100 }, twoLines, false);
    expect(folded).toEqual({
      baselines: [117, 131],
      badgeTop: 118,
      panelTop: 136,
      panelHeight: 0,
      variableBaselines: [],
      height: 40,
    });
    const open = labelLayout({ top: 100 }, twoLines, true);
    expect(open).toEqual({
      baselines: [117, 131],
      badgeTop: 118,
      panelTop: 136,
      panelHeight: 40,
      variableBaselines: [153, 167],
      height: 82,
    });
    // One line: the badge centred on it, in a 26px lane; open, 68px.
    expect(labelLayout({ top: 100 }, oneLine, false)).toMatchObject({
      baselines: [117],
      badgeTop: 104,
      height: 26,
    });
    expect(laneHeightFor(oneLine, true)).toBe(68);
    expect(laneHeightFor(twoLines, true)).toBe(82);
    expect(laneHeightFor(twoLines, false)).toBe(40);
    expect(laneHeightFor({ ...twoLines, variables: ["A=1"] }, true)).toBe(68);
    expect(laneHeightFor(bare)).toBe(20);
    // The rows grow for an expanded lane alone.
    const withVariables = gridGroups({
      commits: [{ sha: SHA_A, started_at: "2026-10-24T05:50:00.000Z" }],
      lanes: [
        lane(".github/workflows/pull.yml", [cell(SHA_A, "", "passed")], {
          env_vars: envVars({
            TEST_CONFIG: "slow",
            PYTORCH_TEST_WITH_SLOW: "1",
            PYTORCH_TEST_SKIP_FAST: "1",
          }),
        }),
        lane(".github/workflows/pull.yml", [cell(SHA_A, "", "passed")], {
          environment: environment({ id: "9", python_version: "3.14" }),
        }),
      ],
      hud_url: null,
      query_duration_ms: 1,
    });
    // Label order puts "default" before "slow".
    const [plain, slow] = withVariables[0].lanes;
    expect(plain.variables).toEqual([]);
    expect(slow.variables).toHaveLength(2);
    expect(gridRows(withVariables).lanes.map((row) => row.height)).toEqual([
      40, 40,
    ]);
    expect(
      gridRows(withVariables, new Set([slow.key])).lanes.map(
        (row) => row.height
      )
    ).toEqual([40, 82]);
  });

  test("says when it knows nothing", () => {
    expect(
      laneLines(
        lane(null, [], { environment: null, env_vars: null }),
        undefined
      )
    ).toEqual({ tokens: ["unknown environment"], details: [] });
    expect(
      laneLines(
        lane(null, [], {
          environment: environment({
            accelerator: "",
            python_version: "",
            cc_compiler: "",
            cc_compiler_version: "",
            os: "",
            os_version: "",
            cpu_architecture: "",
            cpu_capability: "",
          }),
          env_vars: envVars({}),
        }),
        undefined
      )
    ).toEqual({ tokens: ["unknown configuration"], details: [] });
  });
});

describe("gridGroups", () => {
  const grid: RunGrid = {
    commits: [
      { sha: SHA_A, started_at: "2026-10-24T05:50:00.000Z" },
      { sha: SHA_B, started_at: "2026-10-25T10:00:00.000Z" },
      { sha: SHA_C, started_at: "2026-10-26T10:00:00.000Z" },
    ],
    lanes: [
      lane(".github/workflows/pull.yml", [
        cell(SHA_A, "2026-10-24T05:50:00.000Z", "passed"),
        cell(SHA_B, "2026-10-25T10:00:00.000Z", "passed"),
      ]),
      lane(
        ".github/workflows/pull.yml",
        [cell(SHA_A, "2026-10-24T05:51:00.000Z", "skipped")],
        {
          environment: environment({ id: "9", python_version: "3.14" }),
        }
      ),
      lane(".github/workflows/inductor.yml", [
        cell(SHA_B, "2026-10-25T10:02:00.000Z", "timed_out", [
          "timed_out",
          "skipped",
        ]),
        cell(SHA_C, "2026-10-26T10:02:00.000Z", "skipped"),
      ]),
      lane(null, [
        cell(SHA_C, "2026-10-26T10:03:00.000Z", "passed", ["failed", "passed"]),
      ]),
    ],
    hud_url: null,
    query_duration_ms: 1,
  };

  test("orders a workflow's lanes by config, then environment, then variables", () => {
    const when = "2026-10-24T05:50:00.000Z";
    const workflow = ".github/workflows/trunk.yml";
    const cuda = (id: string, version: string) =>
      environment({
        id,
        accelerator: "cuda",
        accelerator_version: version,
      });
    const [group] = gridGroups({
      commits: [{ sha: SHA_A, started_at: when }],
      lanes: [
        // Worst first would lead with this failing lane; label order
        // puts its config last.
        lane(workflow, [cell(SHA_A, when, "failed")], {
          env_vars: envVars({ TEST_CONFIG: "slow" }),
        }),
        lane(workflow, [cell(SHA_A, when, "passed")], {
          environment: cuda("2", "13.4"),
        }),
        lane(workflow, [cell(SHA_A, when, "passed")], {
          environment: cuda("3", "13.2"),
          env_vars: envVars({
            TEST_CONFIG: "default",
            PYTORCH_TEST_WITH_SLOW: "1",
          }),
        }),
        lane(workflow, [cell(SHA_A, when, "passed")], {
          environment: cuda("4", "13.2"),
        }),
        lane(workflow, [cell(SHA_A, when, "passed")], {
          environment: environment({
            id: "5",
            accelerator: "rocm",
            accelerator_version: "7.1",
          }),
        }),
        lane(workflow, [cell(SHA_A, when, "passed")], {
          environment: environment({
            id: "6",
            accelerator: "rocm",
            accelerator_version: "10.1",
          }),
        }),
      ],
      hud_url: null,
      query_duration_ms: 1,
    });
    // Numbers compare as numbers: ROCm 7.1 before 10.1.
    expect(
      group.lanes.map((lane) => [lane.tokens.join(" "), lane.variables.length])
    ).toEqual([
      ["default cuda 13.2", 0],
      ["default cuda 13.2", 1],
      ["default cuda 13.4", 0],
      ["default rocm 7.1", 0],
      ["default rocm 10.1", 0],
      ["slow cpu", 0],
    ]);
    expect(group.status).toBe("failing");
  });

  test("groups lanes under their workflow, worst first, and counts their cells", () => {
    const groups = gridGroups(grid);
    expect(groups.map((group) => [group.name, group.status])).toEqual([
      ["inductor.yml", "failing"],
      [UNKNOWN_WORKFLOW, "flaky"],
      ["pull.yml", "healthy"],
    ]);
    const pull = groups[2];
    expect(
      pull.lanes.map((lane) => [
        lane.status,
        lane.passed,
        lane.failed,
        lane.skipped,
      ])
    ).toEqual([
      ["healthy", 2, 0, 0],
      ["skipped", 0, 0, 1],
    ]);
    expect(pull.lanes[1].tokens).toEqual(["default", "cpu"]);
    expect(pull.lanes[1].details).toEqual([
      "Python 3.14",
      "linux 22.04",
      "x86_64 avx512",
      "gcc 11.4",
    ]);
    expect(groups[0].lanes[0].failed).toBe(1);
    expect(groups[0].lanes[0].cells.get(SHA_B)?.outcome).toBe("timed_out");
    expect(groups[1].lanes[0].failed).toBe(1);
    expect(groups[1].lanes[0].status).toBe("flaky");
  });

  test("narrows the lanes to the outcomes shown and counts those alone", () => {
    const groups = gridGroups(grid);
    expect(filterGroups(groups, CELL_STATUSES)).toBe(groups);
    const failedOnly = filterGroups(groups, ["failed"]);
    expect(
      failedOnly.map((group) => [
        group.name,
        group.lanes.map((lane) => [
          lane.status,
          lane.passed,
          lane.failed,
          lane.skipped,
          Array.from(lane.cells.keys()),
        ]),
      ])
    ).toEqual([["inductor.yml", [["failing", 0, 1, 0, [SHA_B]]]]]);
    const skipped = filterGroups(groups, ["skipped"]);
    expect(skipped.map((group) => group.name)).toEqual([
      "inductor.yml",
      "pull.yml",
    ]);
    expect(skipped[1].lanes.map((lane) => lane.details[0])).toEqual([
      "Python 3.14",
    ]);
    expect(skipped[1].lanes[0].status).toBe("skipped");
    expect(filterGroups(groups, ["other"])).toEqual([]);
  });

  test("lays the rows out as sections of a section row and its lanes", () => {
    const groups = gridGroups(grid);
    const rows = gridRows(groups);
    expect(rows.sections.map((row) => [row.group.name, row.top])).toEqual([
      ["inductor.yml", 0],
      [UNKNOWN_WORKFLOW, 64],
      ["pull.yml", 128],
    ]);
    // Every lane here has an environment, so two lines of label and 40px,
    // whether or not it has a pass for the time bar.
    expect(
      rows.lanes.map((row) => [row.group.name, row.top, row.height])
    ).toEqual([
      ["inductor.yml", 24, 40],
      [UNKNOWN_WORKFLOW, 88, 40],
      ["pull.yml", 152, 40],
      ["pull.yml", 192, 40],
    ]);
    expect(rows.bottom).toBe(232);
    expect(gridRows([])).toEqual({ sections: [], lanes: [], bottom: 0 });
    // A lane of one line is 20px, or 40px with a pass, time bar or not.
    const label = { tokens: ["default"], details: [], variables: [] };
    const timed = {
      cells: new Map([[SHA_A, cell(SHA_A, "", "passed")]]),
      ...label,
    };
    const skips = {
      cells: new Map([[SHA_A, cell(SHA_A, "", "skipped")]]),
      ...label,
    };
    expect(laneHeightFor(timed)).toBe(40);
    expect(laneHeightFor(skips)).toBe(20);
  });

  test("cuts a configuration's passes into stretches, a change having to hold", () => {
    // Steady, with a little noise: one stretch at the median.
    expect(stretches([10, 10, 11, 10, 9, 10, 10, 10])).toEqual([
      { from: 0, to: 8, level: 10, change: null },
    ]);
    // A step that holds: two stretches, the second opening at the first
    // slow pass with its change on the first.
    const stepped = [...Array(12).fill(100), ...Array(12).fill(150)];
    expect(stretches(stepped)).toEqual([
      { from: 0, to: 12, level: 100, change: null },
      { from: 12, to: 24, level: 150, change: 0.5 },
    ]);
    // One slow run, or three, is no change.
    expect(
      stretches([...Array(10).fill(100), 300, ...Array(10).fill(100)])
    ).toHaveLength(1);
    expect(
      stretches([...Array(10).fill(100), 150, 150, 150, ...Array(10).fill(100)])
    ).toHaveLength(1);
    // Up, back, and up again: three changes, each on the stretch before.
    const back = [
      ...Array(10).fill(100),
      ...Array(10).fill(150),
      ...Array(10).fill(100),
      ...Array(10).fill(200),
    ];
    expect(
      stretches(back).map((stretch) => [
        stretch.level,
        changeLabel(stretch.change),
      ])
    ).toEqual([
      [100, "\u2014"],
      [150, "+50%"],
      [100, "\u221233%"],
      [200, "+100%"],
    ]);
    expect(stretches([])).toEqual([]);
    // The first stretch has to rest on five passes too: a lane's first run
    // alone, or its first four, never make one, they join the stretch
    // after them; five do.
    expect(stretches([1000, ...Array(8).fill(2000)])).toEqual([
      { from: 0, to: 9, level: 2000, change: null },
    ]);
    expect(
      stretches([...Array(4).fill(100), ...Array(10).fill(150)]).map(
        (stretch) => [stretch.from, stretch.to, stretch.level]
      )
    ).toEqual([[0, 14, 150]]);
    expect(
      stretches([...Array(5).fill(100), ...Array(10).fill(150)]).map(
        (stretch) => [stretch.from, stretch.to, stretch.level]
      )
    ).toEqual([
      [0, 5, 100],
      [5, 15, 150],
    ]);
  });

  test("places a stretch's label where it has room", () => {
    const texts = { level: "1.3 s", change: "\u221231%" };
    const both = estimatedTextWidth("\u221231% \u00b7 1.3 s");
    const level = estimatedTextWidth("1.3 s");
    // Inside the block: the change and the time, the time alone, the
    // change alone, as the room allows.
    expect(stretchLabel(texts, both, 0)).toEqual({
      form: "both",
      outside: false,
    });
    expect(stretchLabel(texts, both - 1, 0)).toEqual({
      form: "level",
      outside: false,
    });
    expect(stretchLabel(texts, level - 1, 0)).toEqual({
      form: "change",
      outside: false,
    });
    // No room inside: after the block, the same order of preference.
    expect(stretchLabel(texts, 10, both)).toEqual({
      form: "both",
      outside: true,
    });
    expect(stretchLabel(texts, 10, both - 1)).toEqual({
      form: "level",
      outside: true,
    });
    expect(stretchLabel(texts, 10, 10)).toBeNull();
    // A first stretch has only its time to show.
    expect(stretchLabel({ level: "1.3 s", change: null }, level, 0)).toEqual({
      form: "level",
      outside: false,
    });
    expect(stretchLabel({ level: "1.3 s", change: null }, 10, 10)).toBeNull();
  });

  test("finds the stretch whose block covers a column", () => {
    // The columns run newest first, so the oldest stretch's passes have
    // the highest columns: passes on columns 8, 7 and 5 make it, so its
    // block covers columns 5 to 8, the gap at 6 included; the newer
    // stretch's passes on 4, 2, 1 and 0 cover 0 to 4; nothing stands at 9.
    const times = {
      columns: [8, 7, 5, 4, 2, 1, 0],
      stretches: [
        { from: 0, to: 3, level: 1, change: null },
        { from: 3, to: 7, level: 2, change: 1 },
      ],
    };
    expect(
      [0, 1, 3, 4, 5, 6, 8, 9].map(
        (column) => stretchAtColumn(times, column)?.level ?? null
      )
    ).toEqual([2, 2, 2, 2, 1, 1, 1, null]);
    // Columns running the other way are covered the same.
    const ascending = { ...times, columns: [0, 1, 3, 4, 6, 7, 8] };
    expect(
      [0, 2, 3, 4, 5, 8, 9].map(
        (column) => stretchAtColumn(ascending, column)?.level ?? null
      )
    ).toEqual([1, 1, 1, 2, 2, 2, null]);
    expect(stretchAtColumn({ columns: [], stretches: [] }, 0)).toBeNull();
  });

  test("puts the newest commit in the first column", () => {
    expect(columnCommits(grid).map((commit) => commit.sha)).toEqual([
      SHA_C,
      SHA_B,
      SHA_A,
    ]);
    // The API's order is left as it was.
    expect(grid.commits.map((commit) => commit.sha)).toEqual([
      SHA_A,
      SHA_B,
      SHA_C,
    ]);
    expect(columnCommits({ commits: [] })).toEqual([]);
  });

  test("gathers a configuration's passes oldest first for its lane", () => {
    const groups = gridGroups(grid);
    const columns = columnCommits(grid);
    // Passes on the two oldest commits: the two rightmost columns, the
    // older one first.
    expect(laneTimes(groups[2].lanes[0], columns)).toEqual({
      columns: [2, 1],
      durations: [1200, 1200],
      typical: 1200,
      stretches: [{ from: 0, to: 2, level: 1200, change: null }],
    });
    // Nothing passed: nothing to time.
    const nothing = {
      columns: [],
      durations: [],
      typical: null,
      stretches: [],
    };
    expect(laneTimes(groups[0].lanes[0], columns)).toEqual(nothing);
    expect(laneTimes({ cells: new Map() }, columns)).toEqual(nothing);
    // A pass on a retry counts, timed by the attempt that passed alone:
    // 1.2 s, not the 2.4 s of both attempts; on the newest commit, the
    // first column.
    expect(laneTimes(groups[1].lanes[0], columns)).toEqual({
      columns: [0],
      durations: [1200],
      typical: 1200,
      stretches: [{ from: 0, to: 1, level: 1200, change: null }],
    });
    // The times keep the commits' order in time, oldest first, however
    // the columns run.
    const timed = (sha: string, milliseconds: number) =>
      cellOf(sha, "passed", [
        job(["passed"], {
          duration_milliseconds: milliseconds,
          passed_duration_milliseconds: milliseconds,
        }),
      ]);
    expect(
      laneTimes(
        {
          cells: new Map([
            [SHA_A, timed(SHA_A, 1000)],
            [SHA_B, timed(SHA_B, 2000)],
            [SHA_C, timed(SHA_C, 3000)],
          ]),
        },
        columns
      )
    ).toMatchObject({ columns: [2, 1, 0], durations: [1000, 2000, 3000] });
    const retried = cell(SHA_A, "", "passed", ["failed", "passed"]);
    expect(retried.duration_milliseconds).toBe(2400);
    expect(passedEventually(retried)).toBe(true);
    expect(passedEventually(cell(SHA_A, "", "failed"))).toBe(false);
    expect(passedEventually(cell(SHA_A, "", "skipped"))).toBe(false);
  });

  test("tints a stretch against the first and words a change", () => {
    expect(stretchTone(100, 100)).toBe("same");
    expect(stretchTone(109, 100)).toBe("same");
    expect(stretchTone(111, 100)).toBe("slower");
    expect(stretchTone(92, 100)).toBe("same");
    expect(stretchTone(89, 100)).toBe("faster");
    // A tenth either way of the first's time: 10 s against 9 s is slower, as
    // 9 against 10 is faster; after a stretch of no time, slower.
    expect(stretchTone(10000, 9000)).toBe("slower");
    expect(stretchTone(9000, 10000)).toBe("same");
    expect(stretchTone(8900, 10000)).toBe("faster");
    expect(stretchTone(100, 0)).toBe("slower");
    expect(changeLabel(null)).toBe("\u2014");
    expect(changeLabel(0.44)).toBe("+44%");
    expect(changeLabel(-0.083)).toBe("\u22128%");
    expect(changeLabel(0.004)).toBe("0%");
    expect(estimatedTextWidth("+44% \u00b7 1.0 min")).toBe(90);
    expect(estimatedTextWidth("12.9 min")).toBe(52);
  });
});

describe("dayMarks and columnLayout", () => {
  test("marks the first column of each local day and the weekend", () => {
    const noon = (day: number) => new Date(2026, 9, day, 12).toISOString();
    // The columns as the grid has them, newest first: Saturday the 24th
    // in the first column, then Friday's two commits.
    const marks = dayMarks([
      { sha: SHA_C, started_at: noon(24) },
      { sha: SHA_B, started_at: noon(23) },
      { sha: SHA_A, started_at: noon(23) },
    ]);
    expect(marks.map((mark) => [mark.index, mark.weekend])).toEqual([
      [0, true],
      [1, false],
    ]);
    expect(marks[0].date.getDate()).toBe(24);
    // Whatever the order, a day is marked where it begins in it.
    expect(
      dayMarks([
        { sha: SHA_A, started_at: noon(23) },
        { sha: SHA_B, started_at: noon(23) },
        { sha: SHA_C, started_at: noon(24) },
      ]).map((mark) => mark.index)
    ).toEqual([0, 2]);
  });

  test("fits the columns to the room with a gap and a bounded cell", () => {
    expect(columnLayout(0, 1000)).toEqual({
      step: 0,
      gap: 0,
      cellWidth: 0,
      plotWidth: 1000,
    });
    expect(columnLayout(200, 1400)).toEqual({
      step: 7,
      gap: 2,
      cellWidth: 5,
      plotWidth: 1400,
    });
    expect(columnLayout(10, 1400)).toEqual({
      step: 140,
      gap: 2,
      cellWidth: 14,
      plotWidth: 1400,
    });
  });

  test("draws a cell's edge inside its box", () => {
    expect(edgedBox({ x: 10, y: 20, width: 4, height: 10 })).toEqual({
      x: 10.5,
      y: 20.5,
      width: 3,
      height: 9,
    });
    expect(edgedBox({ x: 0, y: 0, width: 1, height: 10 })).toEqual({
      x: 0.5,
      y: 0.5,
      width: 0,
      height: 9,
    });
    // The hovered cell's thicker ring is drawn inside its box the same way.
    expect(edgedBox({ x: 0, y: 0, width: 10, height: 16 }, 1.5)).toEqual({
      x: 0.75,
      y: 0.75,
      width: 8.5,
      height: 14.5,
    });
  });

  test("rounds a cell into a pill by its shorter side", () => {
    expect(cellRadius(5, 10)).toBe(2.5);
    expect(cellRadius(5, 6)).toBe(2.5);
    expect(cellRadius(14, 10)).toBe(5);
    expect(cellRadius(2, 10)).toBe(1);
  });

  test("estimates the label column within reason", () => {
    expect(estimatedLabelWidth(64)).toBe(220);
    expect(estimatedLabelWidth(288)).toBe(328);
    expect(estimatedLabelWidth(640)).toBe(380);
  });

  test("gives the footer a row for the pinned pill and one for the scrollbar", () => {
    expect(footerHeight(false)).toBe(30);
    expect(footerHeight(true)).toBe(52);
    expect(footerHeight(false, true)).toBe(40);
    expect(footerHeight(true, true)).toBe(62);
  });

  test("sets the outcome slots and the commits after the labels", () => {
    // The typical time's figure starts under the first swatch and its bar
    // a short gap after the widest figure, "12.9 min" until the lanes are
    // known; the commits begin a gap after the Outcomes column.
    expect(gridColumns(220)).toEqual({
      outcomes: [
        { swatchX: 226, figureX: 237 },
        { swatchX: 278, figureX: 289 },
        { swatchX: 330, figureX: 341 },
      ],
      typicalFigureX: 226,
      typicalBarX: 283,
      typicalBarWidth: 56,
      rules: [220, 376],
      plotX: 396,
    });
    // The bar moves with the figures' width and is cut to the column.
    expect(gridColumns(220, 32).typicalBarX).toBe(263);
    expect(gridColumns(220, 32).typicalBarWidth).toBe(56);
    expect(gridColumns(220, 100).typicalBarX).toBe(331);
    expect(gridColumns(220, 100).typicalBarWidth).toBe(39);
    expect(gridColumns(220, 100).plotX).toBe(396);
  });

  test("colors an outcome's swatch as the cells it counts", () => {
    expect(outcomeSwatchStatus("passed", { status: "failing" })).toBe("passed");
    expect(outcomeSwatchStatus("skipped", { status: "skipped" })).toBe(
      "skipped"
    );
    expect(outcomeSwatchStatus("failed", { status: "failing" })).toBe("failed");
    expect(outcomeSwatchStatus("failed", { status: "flaky" })).toBe("flaky");
  });
});

describe("the header's hover help", () => {
  test("speaks plainly, names the window and adds the time bar when it is on", () => {
    const shown = headerDescriptions("7 days", true);
    expect(shown.configuration).toBe(
      "The configuration the test ran in: the test config and the device, then the Python version, OS, CPU and compiler. +N vars means more env vars were set. Click it to see them."
    );
    // A legend line per color, the window as the list's tooltips name it.
    expect(shown.outcomes.split("\n")).toEqual([
      "How many commits passed, failed or were skipped in this configuration. Expected failures, unexpected passes and unknowns are shown but not counted.",
      "Green: passed.",
      "Yellow: failed, but all passed on retry.",
      "Red: failed.",
      "Purple: skipped.",
      "Under the counts, the median time a passing run takes within the last 7 days. The bar compares it with the slowest configuration in the table.",
    ]);
    expect(shown.runs.split("\n")).toEqual([
      "The test's result on each commit, newest on the left.",
      "Green: passed.",
      "Yellow: passed on retry.",
      "Red: failed.",
      "Purple: skipped.",
      "A pill splits when a retry changed the result: first attempt on top, final below. If several jobs ran the test on a commit, the worst result wins.",
      "Under the pills, the bar groups commits that take about the same time. The oldest group is grey, newer ones red when slower and green when faster.",
    ]);
    // Without the time bar its sentence goes; without the choices the
    // window is named as such.
    const bare = headerDescriptions(undefined, false);
    expect(bare.runs.split("\n")).toHaveLength(6);
    expect(bare.runs).not.toMatch(/bar/);
    expect(bare.outcomes).toContain("takes within the window.");
    // Nothing runs to a paragraph: every line is a sentence or two.
    for (const text of Object.values(shown)) {
      for (const line of text.split("\n")) {
        expect(line.split(/[.!?]\s/).length).toBeLessThanOrEqual(3);
        expect(line.length).toBeLessThanOrEqual(180);
      }
    }
  });
});

describe("the header's choices", () => {
  const every = CELL_STATUSES;

  test("keeps the time bar for main and takes it from pull requests", () => {
    expect(timeBarAvailable(["main"])).toBe(true);
    expect(timeBarAvailable(["pull_request"])).toBe(false);
    // Pull requests among the sources take the bar too.
    expect(timeBarAvailable(["main", "pull_request"])).toBe(false);
    const chosen = resolveGridQuery({}, options);
    expect(timeBarShown(chosen)).toBe(true);
    expect(timeBarShown({ ...chosen, ranOn: ["pull_request"] })).toBe(false);
    expect(timeBarShown({ ...chosen, timeBar: false })).toBe(false);
    // The reader's choice stays in the URL while pull requests hide the
    // bar, so main shows it again on return.
    expect(
      gridUrlParams({ ...chosen, ranOn: ["pull_request"] }).time_bar
    ).toBeUndefined();
    expect(
      gridUrlParams({ ...chosen, ranOn: ["pull_request"], timeBar: false })
        .time_bar
    ).toBe("0");
  });

  test("come from the URL when the options offer them, else the defaults", () => {
    expect(resolveGridQuery({}, options)).toEqual({
      ranOn: DEFAULT_GRID_RAN_ON,
      window: DEFAULT_GRID_WINDOW,
      outcomes: every,
      timeBar: true,
      commit: "",
      lane: null,
    });
    expect(
      resolveGridQuery(
        { ran_on: "pull_request", window: "14d", outcomes: "flaky,failed" },
        options
      )
    ).toEqual({
      ranOn: ["pull_request"],
      window: "14d",
      outcomes: ["failed", "flaky"],
      timeBar: true,
      commit: "",
      lane: null,
    });
    expect(
      resolveGridQuery(
        { ran_on: "trunk", window: ["7d", "3h"], outcomes: "bogus," },
        options
      )
    ).toEqual({
      ranOn: ["main"],
      window: "3d",
      outcomes: every,
      timeBar: true,
      commit: "",
      lane: null,
    });
    // Both code sources, comma-separated or repeated as the API takes them,
    // in the options' order whatever the URL's, the unknown dropped.
    expect(
      resolveGridQuery({ ran_on: "pull_request,main" }, options).ranOn
    ).toEqual(["main", "pull_request"]);
    expect(
      resolveGridQuery({ ran_on: ["pull_request", "main,trunk"] }, options)
        .ranOn
    ).toEqual(["main", "pull_request"]);
    // The hash sought, trimmed; one value only.
    expect(resolveGridQuery({ commit: " 8f3a1 " }, options).commit).toBe(
      "8f3a1"
    );
    expect(resolveGridQuery({ commit: ["a", "b"] }, options).commit).toBe("");
    expect(resolveGridQuery({ time_bar: "0" }, options).timeBar).toBe(false);
    expect(resolveGridQuery({ time_bar: "1" }, options).timeBar).toBe(true);
    // Repeated as well as comma-separated, as the API reads such parameters.
    expect(
      resolveGridQuery({ outcomes: ["failed", "flaky"] }, options).outcomes
    ).toEqual(["failed", "flaky"]);
  });

  test("name the configuration to mark by both its ids, or not at all", () => {
    expect(
      resolveGridQuery(
        { environment: "2081130751942693630", env_vars: "7" },
        options
      ).lane
    ).toEqual({ environmentId: "2081130751942693630", envVarsId: "7" });
    expect(resolveGridQuery({ environment: "1" }, options).lane).toBeNull();
    expect(resolveGridQuery({ env_vars: "7" }, options).lane).toBeNull();
    // An id is a UInt64 as a decimal string, as the API spells ids, and one
    // value only.
    expect(
      resolveGridQuery({ environment: "abc", env_vars: "7" }, options).lane
    ).toBeNull();
    expect(
      resolveGridQuery({ environment: ["1", "2"], env_vars: "7" }, options).lane
    ).toBeNull();
    // A lane is the pin's when both its ids are.
    const lane = {
      environment: { id: "1" } as EnvironmentRecord,
      envVars: { id: "7" } as EnvVarsRecord,
    };
    expect(lanePinned(lane, { environmentId: "1", envVarsId: "7" })).toBe(true);
    expect(lanePinned(lane, { environmentId: "1", envVarsId: "8" })).toBe(
      false
    );
    expect(lanePinned(lane, null)).toBe(false);
    expect(
      lanePinned(
        { environment: null, envVars: lane.envVars },
        { environmentId: "1", envVarsId: "7" }
      )
    ).toBe(false);
  });

  test("go back into the URL without the defaults", () => {
    expect(
      gridUrlParams({
        ranOn: ["main"],
        window: "3d",
        outcomes: every,
        timeBar: true,
        commit: "",
        lane: null,
      })
    ).toEqual({
      ran_on: undefined,
      window: undefined,
      outcomes: undefined,
      time_bar: undefined,
      commit: undefined,
      environment: undefined,
      env_vars: undefined,
    });
    expect(
      gridUrlParams({
        ranOn: ["pull_request"],
        window: "3h",
        outcomes: ["failed", "flaky"],
        timeBar: false,
        commit: "8f3a1",
        lane: { environmentId: "2081130751942693630", envVarsId: "7" },
      })
    ).toEqual({
      ran_on: "pull_request",
      window: "3h",
      outcomes: "failed,flaky",
      time_bar: "0",
      commit: "8f3a1",
      environment: "2081130751942693630",
      env_vars: "7",
    });
    // Both code sources, comma-separated.
    expect(
      gridUrlParams({
        ranOn: ["main", "pull_request"],
        window: "7d",
        outcomes: every,
        timeBar: true,
        commit: "",
        lane: null,
      }).ran_on
    ).toBe("main,pull_request");
  });

  test("find the commit a hash names, or say why there is none", () => {
    const commits = [{ sha: SHA_A }, { sha: SHA_B }, { sha: SHA_C }];
    expect(commitSearch(commits, "")).toEqual({ kind: "empty" });
    expect(commitSearch(commits, "  ")).toEqual({ kind: "empty" });
    expect(commitSearch(commits, SHA_B)).toEqual({ kind: "found", column: 1 });
    expect(commitSearch(commits, SHA_C.slice(0, 7).toUpperCase())).toEqual({
      kind: "found",
      column: 2,
    });
    expect(commitSearch(commits, "ffffffff")).toEqual({ kind: "none" });
    expect(commitSearch(commits, "not a hash")).toEqual({ kind: "invalid" });
    expect(commitSearch(commits, "g")).toEqual({ kind: "invalid" });
    const shared = SHA_A[0] === SHA_B[0] || SHA_A[0] === SHA_C[0];
    expect(commitSearch(commits, SHA_A[0]).kind).toBe(
      shared ? "several" : "found"
    );
    expect(commitSearch([], SHA_A)).toEqual({ kind: "none" });
    // The field's message, with the key labels of the choices in force.
    const message = (search: ReturnType<typeof commitSearch>, text = "8f3a1") =>
      commitSearchMessage(search, text, "main", "last 7 days");
    expect(message({ kind: "empty" })).toBeNull();
    expect(message({ kind: "found", column: 0 })).toBeNull();
    expect(message({ kind: "none" })).toBe(
      "No commit starting with 8f3a1 in the last 7 days of main. Widen the window, or check the hash."
    );
    expect(message({ kind: "several", count: 3 }, "8f")).toBe(
      "8f commits start with 8f. Type more of the hash.".replace(
        "8f commits",
        "3 commits"
      )
    );
    expect(message({ kind: "invalid" })).toBe(
      "A commit hash is hex digits only, 0-9 and a-f."
    );
  });

  test("address the grid at the runs endpoint, the outcomes and the pin being the page's own", () => {
    expect(
      testGridApiUrl("42", {
        ranOn: ["main"],
        window: "7d",
        outcomes: ["failed"],
        timeBar: true,
        commit: "",
        lane: { environmentId: "1", envVarsId: "7" },
      })
    ).toBe("/api/tests/test/42/runs?group_by=commit&ran_on=main&window=7d");
    // Both code sources go as the API takes them, comma-separated.
    expect(
      testGridApiUrl("42", {
        ranOn: ["main", "pull_request"],
        window: "7d",
        outcomes: every,
        timeBar: true,
        commit: "",
        lane: null,
      })
    ).toBe(
      "/api/tests/test/42/runs?group_by=commit&ran_on=main%2Cpull_request&window=7d"
    );
  });

  test("name the outcomes shown on the key and in the empty sentence", () => {
    expect(outcomesLabel(every)).toBe("All outcomes");
    expect(outcomesLabel(["failed"])).toBe("Failed");
    expect(outcomesLabel(["failed", "flaky"])).toBe("Failed, Flaky");
    expect(outcomesLabel(["failed", "flaky", "passed"])).toBe("3 outcomes");
    expect(outcomesPhrase(["failed"])).toBe("failed");
    expect(outcomesPhrase(["failed", "flaky"])).toBe("failed or flaky");
    expect(outcomesPhrase(["failed", "flaky", "skipped"])).toBe(
      "failed, flaky or skipped"
    );
  });
});

describe("useTestGrid", () => {
  const emptyGrid: RunGrid = {
    commits: [],
    lanes: [],
    hud_url: null,
    query_duration_ms: 1,
  };
  let fetchMock: jest.Mock;

  function stubFetch(respond: () => Promise<Response>) {
    return jest.fn(
      async (_input: string | URL | globalThis.Request, _init?: RequestInit) =>
        respond()
    );
  }

  function Probe({
    testId,
    query,
  }: {
    testId: string | undefined;
    query: Parameters<typeof useTestGrid>[1];
  }) {
    const state = useTestGrid(testId, query);
    return (
      <span>
        {JSON.stringify({
          grid: state.grid,
          loading: state.loading,
          timing:
            state.timing === null
              ? null
              : {
                  queryDurationMs: state.timing.queryDurationMs,
                  elapsed: typeof state.timing.elapsedMs,
                },
          status: (state.error as { status?: number } | undefined)?.status,
        })}
      </span>
    );
  }

  async function render(
    testId: string | undefined,
    query: Parameters<typeof useTestGrid>[1]
  ) {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <SWRConfig
          value={{
            provider: () => new Map(),
            dedupingInterval: 0,
            errorRetryInterval: 1,
            loadingTimeout: 0,
          }}
        >
          <Probe testId={testId} query={query} />
        </SWRConfig>
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    return JSON.parse(
      (renderer.root.findByType("span").children as string[]).join("")
    );
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("asks for the grid of the choices once both are known", async () => {
    fetchMock = stubFetch(async () => Response.json(emptyGrid));
    global.fetch = fetchMock as unknown as typeof fetch;
    const query = {
      ranOn: ["main"],
      window: "7d",
      outcomes: CELL_STATUSES,
      timeBar: true,
      commit: "",
      lane: null,
    } as const;
    expect(await render(undefined, query)).toEqual({
      loading: true,
      timing: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await render("42", query)).toEqual({
      grid: emptyGrid,
      loading: false,
      timing: { queryDurationMs: 1, elapsed: "number" },
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/tests/test/42/runs?group_by=commit&ran_on=main&window=7d"
    );
  });

  test("keeps the status of a refusal for the page to read", async () => {
    fetchMock = stubFetch(async () =>
      Response.json({ error: "forbidden", code: "forbidden" }, { status: 403 })
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    expect(
      await render("42", {
        ranOn: ["main"],
        window: "7d",
        outcomes: CELL_STATUSES,
        timeBar: true,
        commit: "",
        lane: null,
      })
    ).toEqual({
      loading: false,
      timing: null,
      status: 403,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("the time bar's floor", () => {
  test("ignores millisecond jitter and ends a stretch that took no time", () => {
    expect(TIME_FLOOR_MS).toBe(100);
    // A 2 ms test is a millisecond off every other run: one stretch, not a
    // dozen labelled "+100%".
    const jitter = Array.from(
      { length: 250 },
      (_value, index) => 1 + (index % 2)
    );
    expect(stretches(jitter)).toHaveLength(1);
    // Against a tenth of a second, a change counts once it is 15 ms.
    expect(
      stretches([...Array(10).fill(10), ...Array(10).fill(24)])
    ).toHaveLength(1);
    const grew = stretches([...Array(10).fill(10), ...Array(10).fill(30)]);
    expect(grew.map((stretch) => [stretch.from, stretch.to])).toEqual([
      [0, 10],
      [10, 20],
    ]);
    expect(grew[1].change).toBe(2);
    // A stretch at no time ends when the test starts taking time.
    const fromNothing = stretches([
      ...Array(8).fill(0),
      ...Array(12).fill(5000),
    ]);
    expect(fromNothing.map((stretch) => stretch.level)).toEqual([0, 5000]);
    // The tint has the same floor: against 50 ms, 60 is the same, 70 slower
    // and 35 faster; a stretch after one of no time is slower.
    expect(stretchTone(60, 50)).toBe("same");
    expect(stretchTone(70, 50)).toBe("slower");
    expect(stretchTone(35, 50)).toBe("faster");
    expect(stretchTone(5000, 0)).toBe("slower");
  });
});

describe("narrowing the outcomes shown", () => {
  test("gives a lane the status of the cells shown, so the failed swatch follows them", () => {
    const commits = [
      { sha: SHA_A, started_at: "2026-10-24T05:00:00.000Z" },
      { sha: SHA_B, started_at: "2026-10-24T06:00:00.000Z" },
      { sha: SHA_C, started_at: "2026-10-24T07:00:00.000Z" },
    ];
    const lane: RunGridLane = {
      workflow_path: ".github/workflows/pull.yml",
      environment: environment(),
      env_vars: envVars({ TEST_CONFIG: "default" }),
      cells: [
        cell(SHA_A, commits[0].started_at, "failed"),
        cell(SHA_B, commits[1].started_at, "passed", ["failed", "passed"]),
        cell(SHA_C, commits[2].started_at, "passed"),
      ],
    };
    const groups = gridGroups({
      commits,
      lanes: [lane],
      hud_url: null,
      query_duration_ms: 0,
    });
    expect(groups[0].lanes[0].status).toBe("failing");
    expect(outcomeSwatchStatus("failed", groups[0].lanes[0])).toBe("failed");
    // Only the recoveries shown: a flaky lane with one failed count under a
    // yellow swatch, as the legend says.
    const [flakyOnly] = filterGroups(groups, ["flaky"])[0].lanes;
    expect(flakyOnly.status).toBe("flaky");
    expect([flakyOnly.passed, flakyOnly.failed, flakyOnly.skipped]).toEqual([
      0, 1, 0,
    ]);
    expect(outcomeSwatchStatus("failed", flakyOnly)).toBe("flaky");
    // Only the passes: healthy; only the skips: nothing left to show.
    expect(filterGroups(groups, ["passed"])[0].lanes[0].status).toBe("healthy");
    expect(filterGroups(groups, ["skipped"])).toEqual([]);
    // The group keeps its order by the unnarrowed status.
    expect(filterGroups(groups, ["passed"])[0].status).toBe("failing");
  });

  test("holds the cells at the minimum and widens the plot past the room", () => {
    // 500 commits in 1,400px would be 2.8px each: the cells stay 4px with
    // a pixel of gap and the plot runs 2,500px, to scroll.
    expect(MIN_CELL_WIDTH).toBe(4);
    expect(columnLayout(500, 1400)).toEqual({
      step: 5,
      gap: 1,
      cellWidth: 4,
      plotWidth: 2500,
    });
    expect(columnLayout(700, 1400).plotWidth).toBe(3500);
    // 280 fit exactly at the minimum, so nothing scrolls; one more and the
    // plot is a step wider than the room.
    expect(columnLayout(280, 1400)).toEqual({
      step: 5,
      gap: 1,
      cellWidth: 4,
      plotWidth: 1400,
    });
    expect(columnLayout(281, 1400).plotWidth).toBe(1405);
    // A pull request week on a 1,250px plot.
    expect(columnLayout(1435, 1250).plotWidth).toBe(7175);
  });
});
