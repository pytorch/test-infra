import { GET } from "app/api/tests/cost/cases/route";
import type { RawQuery } from "lib/api/parameters";
import { ErrorResponseSchema } from "lib/api/schema";
import {
  CASES_GATE,
  CASES_MAX_SECONDS,
  casesGateQuery,
  casesLanes,
  casesScanQuery,
  compactCases,
  coveredDays,
  coveredSide,
  getCostCases,
  scanSeconds,
} from "lib/api/tests/cost/cases";
import {
  CASES_TOP,
  casesEcho,
  costCasesUrl,
} from "lib/api/tests/cost/contracts";
import { CostCasesSchema } from "lib/api/tests/cost/types";
import { CI_WORKLOAD_HEAVY } from "lib/api/tests/database";
import * as clickhouse from "lib/clickhouse";
import { callRoute } from "test/api/routes";

// The routes are behind the GitHub gate, which has its own tests (auth.test.ts);
// here the handlers answer as themselves.
jest.mock("lib/api/auth", () => ({
  requireGithubWriteAccess: (handler: unknown) => handler,
}));

const TODAY = "2026-11-19";
const NOW = new Date(`${TODAY}T08:00:00Z`);
const A = { from: "2026-11-05", to: "2026-11-11" };
const B = { from: "2026-11-12", to: "2026-11-18" };
const PARAMS = {
  repo: "pytorch/pytorch",
  file: "test/inductor/test_cpu_repro.py",
  machine: "Linux x86_64 avx512",
  a: "2026-11-05..2026-11-11",
  b: "2026-11-12..2026-11-18",
};

describe("the days the runs table holds", () => {
  test("a side is clipped to today − 13 .. yesterday, reported as asked", () => {
    expect(coveredSide(A, TODAY)).toEqual({
      ...A,
      covered_from: "2026-11-06",
      covered_days: 6,
    });
    expect(coveredSide(B, TODAY)).toEqual({
      ...B,
      covered_from: "2026-11-12",
      covered_days: 7,
    });
    expect(
      coveredSide({ from: "2026-10-20", to: "2026-10-26" }, TODAY)
    ).toEqual({
      from: "2026-10-20",
      to: "2026-10-26",
      covered_from: null,
      covered_days: 0,
    });
    // Today is never read: its runs are still arriving.
    expect(
      coveredSide({ from: "2026-11-19", to: "2026-11-19" }, TODAY)
    ).toMatchObject({ covered_from: null, covered_days: 0 });
  });

  test("overlapping sides read their shared days once", () => {
    const a = coveredSide({ from: "2026-11-10", to: "2026-11-16" }, TODAY);
    const b = coveredSide({ from: "2026-11-12", to: "2026-11-18" }, TODAY);
    expect(coveredDays(a, b)).toBe(9);
  });
});

describe("the gate", () => {
  test("predicts the scan from the file's tests and the days; calibrated files land on the right side of 45 s", () => {
    // query-validation.md, "The cases gate": measured at 4 threads over 13 days.
    expect(scanSeconds(1325, 13)).toBeCloseTo(20.4, 0); // test_cpu_repro.py, 19.8 s
    expect(scanSeconds(3437, 13)).toBeLessThan(CASES_MAX_SECONDS); // test_flex_attention.py, 27.7 s
    expect(scanSeconds(9265, 13)).toBeGreaterThan(CASES_MAX_SECONDS); // test_torchinductor.py, 58.9 s
    expect(scanSeconds(9265, 7)).toBeLessThan(CASES_MAX_SECONDS); // B alone
    expect(scanSeconds(36405, 13)).toBeGreaterThan(CASES_MAX_SECONDS); // test_decomp.py, 5.1 G rows
    expect(scanSeconds(188568, 1)).toBeLessThan(CASES_MAX_SECONDS); // test_ops.py, one day
    expect(scanSeconds(188568, 13)).toBeCloseTo(
      CASES_GATE.fixedSeconds +
        13 * CASES_GATE.maxRowsPerDay * CASES_GATE.secondsPerRow,
      0
    );
    expect(scanSeconds(0, 13)).toBe(0);
  });

  test("one environment costs what all do, so every lane carries the whole estimate", () => {
    const lanes = casesLanes(
      [
        { environment: "1", ms: 10, tests: 9265 },
        { environment: "2", ms: 5, tests: "9265" },
      ],
      13
    );
    expect(lanes.map((l) => l.environment)).toEqual(["1", "2"]);
    expect(lanes[0].estimate).toBe(lanes[1].estimate);
    expect(lanes.every((l) => l.tooBig)).toBe(true);
  });

  test("reads test_cost and the tests catalog only, never the runs", () => {
    const sql = casesGateQuery();
    expect(sql).not.toContain("ci.runs");
    expect(sql).toContain("uniqExact(id) FROM ci.tests");
    expect(sql).toContain("test_file = {file: String}");
    expect(sql).toContain("(day, computed_at) IN (");
  });
});

describe("the scan", () => {
  test("reads the runs once, explicit columns, configurations exact and cells ranked", () => {
    const sql = casesScanQuery();
    expect(sql.match(/ci\.runs/g)).toHaveLength(1);
    expect(sql).not.toMatch(/outcome_summary|run\.\*/);
    expect(sql).toContain(
      "GROUP BY GROUPING SETS ((side, tests_id, environments_id, env_vars_id),\n        (side, environments_id, env_vars_id))"
    );
    expect(sql).toContain("uniqExact(run.tests_id) AS tests");
    expect(sql).toContain(
      `WHERE tests_id = 0 OR change_rank <= ${CASES_TOP} OR b_rank <= 50`
    );
    expect(sql).toContain("run.tests_id IN (SELECT id FROM ci.tests");
    expect(sql).toContain("arrayJoin(arrayFilter(s -> s >= 0, [");
  });

  test("compactCases: configurations from the set without tests, cells indexed", () => {
    const out = compactCases([
      {
        side: 0,
        test: "0",
        environment: "7",
        env_vars: "9",
        tests: 2,
        runs: 10,
        skipped: 1,
        failed: 0,
        reruns: 0,
        test_ms: 500,
        ranked_of: 3,
      },
      {
        side: 0,
        test: "11",
        environment: "7",
        env_vars: "9",
        tests: 1,
        runs: 6,
        skipped: 1,
        failed: 0,
        reruns: 0,
        test_ms: 300,
        ranked_of: 3,
      },
      {
        side: 1,
        test: "12",
        environment: "8",
        env_vars: "9",
        tests: 1,
        runs: "4",
        skipped: 0,
        failed: 1,
        reruns: 1,
        test_ms: "90",
        ranked_of: "3",
      },
    ]);
    expect(out).toEqual({
      testIds: ["11", "12"],
      environmentIds: ["7", "8"],
      envVarsIds: ["9"],
      configs: [[0, 0, 0, 2, 10, 1, 0, 0, 500]],
      cells: [
        [0, 0, 0, 0, 6, 1, 0, 0, 300],
        [1, 1, 1, 0, 4, 0, 1, 1, 90],
      ],
      rankedOf: 3,
    });
  });
});

describe("getCostCases", () => {
  afterEach(() => jest.restoreAllMocks());

  test("too big: the gate answers, nothing heavy runs", async () => {
    const query = jest
      .spyOn(clickhouse, "queryClickhouse")
      .mockResolvedValue([
        { environment: "17266170437131304125", ms: 100, tests: 188568 },
      ]);
    const answer = await getCostCases(
      { ...PARAMS, file: "test/test_ops.py" },
      NOW
    );
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][2]).toBe("tests_cost_cases_gate");
    expect(query.mock.calls[0][4]).toBeUndefined();
    expect(query.mock.calls[0][1]).toMatchObject({
      a_from: "2026-11-06",
      a_end: "2026-11-12",
      b_from: "2026-11-12",
      b_end: "2026-11-19",
      environment: "",
    });
    expect(answer.status).toBe("too_big");
    expect(answer.lanes[0].tooBig).toBe(true);
    expect(answer.configs).toEqual([]);
    expect(answer.cells).toEqual([]);
    expect(CostCasesSchema.parse(answer)).toEqual(answer);
  });

  test("ok: the scan runs in the heavy workload, the lookups outside it, and the answer echoes the request", async () => {
    const query = jest
      .spyOn(clickhouse, "queryClickhouse")
      .mockImplementation(async (_sql, _params, id) => {
        switch (id) {
          case "tests_cost_cases_gate":
            return [{ environment: "7", ms: 100, tests: 1325 }];
          case "tests_cost_cases":
            return [
              {
                side: 1,
                test: "0",
                environment: "7",
                env_vars: "9",
                tests: 1,
                runs: 4,
                skipped: 0,
                failed: 0,
                reruns: 0,
                test_ms: 90,
                ranked_of: 1,
              },
              {
                side: 1,
                test: "11",
                environment: "7",
                env_vars: "9",
                tests: 1,
                runs: 4,
                skipped: 0,
                failed: 0,
                reruns: 0,
                test_ms: 90,
                ranked_of: 1,
              },
            ];
          case "tests_cost_cases_tests":
            return [{ id: "11", suite: "CPUReproTests", name: "test_a" }];
          case "tests_cost_cases_envs":
            return [
              {
                environment_id_string: "7",
                os: "linux",
                os_version: "22.04",
                cpu_architecture: "x86_64",
                cpu_capability: "avx512",
                python_version: "3.10",
                cc_compiler: "gcc",
                cc_compiler_version: "11.4",
                accelerator: "cpu",
                accelerator_version: "",
                device_name: "",
                device_count: 0,
                environment_first_seen_at: "2026-10-23T23:01:48.356Z",
              },
            ];
          case "tests_cost_cases_env_vars":
            return [
              {
                env_var_set_id_string: "9",
                env_vars: { TEST_CONFIG: "default" },
                env_vars_first_seen_at: "2026-10-23T23:01:48.356Z",
              },
            ];
          default:
            return [];
        }
      });
    const answer = await getCostCases(PARAMS, NOW);
    const calls = query.mock.calls.map((c) => [c[2], c[4]]);
    expect(calls).toEqual([
      ["tests_cost_cases_gate", undefined],
      ["tests_cost_cases", CI_WORKLOAD_HEAVY],
      ["tests_cost_cases_tests", undefined],
      ["tests_cost_cases_envs", undefined],
      ["tests_cost_cases_env_vars", undefined],
    ]);
    expect(query.mock.calls[1][1]).toMatchObject({ a_days: 6, b_days: 7 });
    expect(CostCasesSchema.parse(answer)).toEqual(answer);
    expect(answer).toMatchObject({
      status: "ok",
      tests: [{ id: "11", suite: "CPUReproTests", name: "test_a" }],
      configs: [[1, 0, 0, 1, 4, 0, 0, 0, 90]],
      cells: [[1, 0, 0, 0, 4, 0, 0, 0, 90]],
      ranked_of: 1,
    });
    expect(answer.environments[0].cpu_capability).toBe("avx512");
    expect(answer.env_vars[0].values).toEqual({ TEST_CONFIG: "default" });
    expect(casesEcho(answer)).toBe(
      costCasesUrl(PARAMS.repo, PARAMS.file, PARAMS.machine, A, B)
    );
  });

  test("sides older than the runs table read nothing", async () => {
    const query = jest.spyOn(clickhouse, "queryClickhouse");
    const answer = await getCostCases(
      { ...PARAMS, a: "2026-10-01..2026-10-07", b: "2026-10-08..2026-10-14" },
      NOW
    );
    expect(query).not.toHaveBeenCalled();
    expect(answer).toMatchObject({ status: "ok", lanes: [], configs: [] });
  });
});

function get(query: RawQuery) {
  return callRoute(GET, "/api/tests/cost/cases", query);
}

describe("app/api/tests/cost/cases", () => {
  afterEach(() => jest.restoreAllMocks());

  test.each([
    { ...PARAMS, file: undefined },
    { ...PARAMS, file: "" },
    { ...PARAMS, machine: undefined },
    { ...PARAMS, environment: "abc" },
    { ...PARAMS, environment: "0" },
    { ...PARAMS, a: "2026-11-05" },
    { ...PARAMS, workflow: "pull" },
  ])("rejects bad parameters before querying %j", async (query) => {
    const spy = jest.spyOn(clickhouse, "queryClickhouse");
    const res = await get(query);
    expect(res.status).toBe(400);
    expect(ErrorResponseSchema.parse(res.body)).toEqual(res.body);
    expect(spy).not.toHaveBeenCalled();
  });

  test("answers one environment, cached privately for an hour, echoing the URL", async () => {
    jest.spyOn(clickhouse, "queryClickhouse").mockResolvedValue([]);
    const res = await get({ ...PARAMS, environment: "8205838994554724426" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=3600");
    expect(casesEcho(res.body)).toBe(
      costCasesUrl(
        PARAMS.repo,
        PARAMS.file,
        PARAMS.machine,
        A,
        B,
        "8205838994554724426"
      )
    );
  });
});
