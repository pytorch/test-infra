import { queryClickhouse } from "lib/api/tests/clickhouse";
import {
  addDays,
  CASES_TOP,
  type CasesLane,
  type CasesSide,
  type CostCases,
  type Day,
  type DayRange,
  daysIn,
} from "lib/api/tests/cost/contracts";
import {
  type CostCasesParams,
  parseDayRange,
} from "lib/api/tests/cost/parameters";
import { latestDayRows, MACHINE, TEST_COST } from "lib/api/tests/cost/query";
import { environmentsQuery } from "lib/api/tests/cost/scope";
import {
  CI_DATABASE,
  CI_WORKLOAD_HEAVY,
  RUNS_RETENTION_DAYS,
} from "lib/api/tests/database";
import {
  type EnvironmentRow,
  type EnvVarsRow,
  toEnvironment,
  toEnvVars,
} from "lib/api/tests/mapping";

// B's largest cells kept beside the CASES_TOP biggest moves.
export const CASES_B_TOP = 50;

// What the gate allows: a scan predicted to take longer than this at 4
// threads is not run (the heavy profile stops a query at 60 s).
export const CASES_MAX_SECONDS = 45;

// The gate's model, calibrated in query-validation.md ("The cases gate").
// The runs table is sorted by test first, so the scan reads every granule
// holding one of the file's tests in each part of each covered day, whatever
// the environments: a file's rows read grow with its tests (sublinearly, as
// tests share granules) and with the days, and one environment reads as much
// as all of them. Predicted rows = days × min(maxRowsPerDay, rowsPerDayAt ×
// (tests / atTests) ^ exponent); seconds at 4 threads = fixed + rows ×
// secondsPerRow, the slowest rate measured.
export const CASES_GATE = {
  atTests: 1325,
  rowsPerDayAt: 44e6,
  exponent: 0.7,
  maxRowsPerDay: 835e6,
  secondsPerRow: 34e-9,
  fixedSeconds: 1,
};

// The predicted scan time of a file of tests test cases over days covered
// days, in seconds at 4 threads, to a tenth.
export function scanSeconds(tests: number, days: number): number {
  if (tests <= 0 || days <= 0) return 0;
  const g = CASES_GATE;
  const perDay = Math.min(
    g.maxRowsPerDay,
    g.rowsPerDayAt * Math.pow(tests / g.atTests, g.exponent)
  );
  return (
    Math.round((g.fixedSeconds + days * perDay * g.secondsPerRow) * 10) / 10
  );
}

// The days of a side the runs table still holds in full: from 13 days before
// today (the 14-day TTL may have started on the day before) to yesterday.
export function coveredSide(range: DayRange, today: Day): CasesSide {
  const first = addDays(today, -(RUNS_RETENTION_DAYS - 1));
  const last = addDays(today, -1);
  const from = range.from > first ? range.from : first;
  const to = range.to < last ? range.to : last;
  return from > to
    ? { ...range, covered_from: null, covered_days: 0 }
    : { ...range, covered_from: from, covered_days: daysIn({ from, to }) };
}

// The covered days of a side as the scan binds them, [from, end): an empty
// interval when none is covered.
function bounds(side: CasesSide, today: Day): [Day, Day] {
  if (side.covered_from === null) return [today, today];
  return [side.covered_from, addDays(side.covered_from, side.covered_days)];
}

// The machine's environments (or the one asked for, if it is the
// machine's) that ran the file on the covered days, by test_cost, largest
// first, with the file's distinct tests in the catalog: the gate's signal,
// two small reads.
export function casesGateQuery(): string {
  const days = `(day >= {a_from: Date} AND day < {a_end: Date}
      OR day >= {b_from: Date} AND day < {b_end: Date})`;
  return `
SELECT toString(environments_id) AS environment,
  sum(occupancy_runner_milliseconds) AS ms,
  (SELECT uniqExact(id) FROM ${CI_DATABASE}.tests
    WHERE repo = {repo: String} AND file = {file: String}) AS tests
FROM ${TEST_COST}
WHERE repo = {repo: String}
  AND test_file = {file: String}
  AND ${days}
  AND environments_id IN (${machineEnvironments()})
  AND ${latestDayRows(days)}
GROUP BY environments_id
ORDER BY ms DESC, environment`;
}

function machineEnvironments(): string {
  return `SELECT id FROM ${CI_DATABASE}.environments FINAL
      WHERE ${MACHINE.replace(/\n/g, " ")} = {machine: String}
        AND (empty({environment: String}) OR id = toUInt64OrZero({environment: String}))`;
}

function fileTests(): string {
  return `SELECT id FROM ${CI_DATABASE}.tests
      WHERE repo = {repo: String} AND file = {file: String}`;
}

// The file's configurations and test cases on the machine in A and B, in one
// pass over the runs table (ClickHouse inlines a CTE at each reference, so
// the runs are named once): every configuration exact, from the grouping set
// (side, environment, env_vars) whose tests are distinct tests; and the test
// × configuration cells, of which only the CASES_TOP that moved most in test
// time a day (B's a day less A's a day) and B's CASES_B_TOP largest are kept,
// ranked by window functions over the grouped rows. Attempts are rows:
// runs counts every attempt, reruns those with rerun_number > 0, failed
// those that failed, errored, crashed or timed out. Explicit columns only.
export function casesScanQuery(): string {
  const inA =
    "run.started_at >= {a_from: Date} AND run.started_at < {a_end: Date}";
  const inB =
    "run.started_at >= {b_from: Date} AND run.started_at < {b_end: Date}";
  const key = "tests_id, environments_id, env_vars_id";
  return `
SELECT side, toString(tests_id) AS test, toString(environments_id) AS environment,
  toString(env_vars_id) AS env_vars, tests, runs, skipped, failed, reruns, test_ms,
  ranked_of
FROM (
  SELECT *,
    dense_rank() OVER (PARTITION BY tests_id = 0
      ORDER BY abs(change) DESC, ${key}) AS change_rank,
    dense_rank() OVER (PARTITION BY tests_id = 0
      ORDER BY b_ms DESC, ${key}) AS b_rank,
    uniqExact((${key})) OVER (PARTITION BY tests_id = 0) AS ranked_of
  FROM (
    SELECT *,
      sumIf(test_ms, side = 1) OVER (PARTITION BY ${key}) AS b_ms,
      b_ms / greatest({b_days: UInt32}, 1)
        - sumIf(test_ms, side = 0) OVER (PARTITION BY ${key})
          / greatest({a_days: UInt32}, 1) AS change
    FROM (
      SELECT
        arrayJoin(arrayFilter(s -> s >= 0, [if(${inA}, 0, -1), if(${inB}, 1, -1)])) AS side,
        run.tests_id AS tests_id,
        run.environments_id AS environments_id,
        run.env_vars_id AS env_vars_id,
        uniqExact(run.tests_id) AS tests,
        count() AS runs,
        countIf(run.outcome = 'skipped') AS skipped,
        countIf(run.outcome IN ('failed', 'error', 'crashed', 'timed_out')) AS failed,
        countIf(run.rerun_number > 0) AS reruns,
        sum(greatest(0, dateDiff('millisecond', run.started_at, run.ended_at))) AS test_ms
      FROM ${CI_DATABASE}.runs AS run
      WHERE run.tests_id IN (${fileTests()})
        AND run.environments_id IN (${machineEnvironments()})
        AND (${inA} OR ${inB})
      GROUP BY GROUPING SETS ((side, tests_id, environments_id, env_vars_id),
        (side, environments_id, env_vars_id))
    )
  )
)
WHERE tests_id = 0 OR change_rank <= ${CASES_TOP} OR b_rank <= ${CASES_B_TOP}
ORDER BY side, tests_id, environments_id, env_vars_id`;
}

// The tests, environments and env var sets the scan's rows name.
export function casesTestsQuery(): string {
  return `
SELECT toString(id) AS id, suite, case_name AS name
FROM ${CI_DATABASE}.tests
WHERE id IN CAST({ids: Array(String)}, 'Array(UInt64)')
ORDER BY id
LIMIT 1 BY id`;
}

export function casesEnvVarsQuery(): string {
  return `
SELECT toString(id) AS env_var_set_id_string, env_vars,
  first_seen_at AS env_vars_first_seen_at
FROM ${CI_DATABASE}.env_vars FINAL
WHERE id IN CAST({ids: Array(String)}, 'Array(UInt64)')`;
}

export interface GateRow {
  environment: string;
  ms: number | string;
  tests: number | string;
}

export interface ScanRow {
  side: number | string;
  test: string;
  environment: string;
  env_vars: string;
  tests: number | string;
  runs: number | string;
  skipped: number | string;
  failed: number | string;
  reruns: number | string;
  test_ms: number | string;
  ranked_of: number | string;
}

// The gate per environment. One environment reads the same granules as
// every environment of the machine (the runs are sorted by test first), so
// each lane's estimate is the whole scan's.
export function casesLanes(rows: GateRow[], days: number): CasesLane[] {
  return rows.map((r) => {
    const estimate = scanSeconds(Number(r.tests), days);
    return {
      environment: r.environment,
      estimate,
      tooBig: estimate > CASES_MAX_SECONDS,
    };
  });
}

// The distinct days A and B cover: the partitions the scan reads.
export function coveredDays(a: CasesSide, b: CasesSide): number {
  const days = new Set<string>();
  for (const side of [a, b]) {
    if (side.covered_from === null) continue;
    for (let i = 0; i < side.covered_days; i++) {
      days.add(addDays(side.covered_from, i));
    }
  }
  return days.size;
}

// The scan's rows as /cases answers them: configurations (test id 0 in the
// grouping set without tests) and cells as index tuples into the tests,
// environments and env var sets they name.
export function compactCases(rows: ScanRow[]): {
  testIds: string[];
  environmentIds: string[];
  envVarsIds: string[];
  configs: CostCases["configs"];
  cells: CostCases["cells"];
  rankedOf: number;
} {
  const environmentIds = Array.from(new Set(rows.map((r) => r.environment)));
  const envVarsIds = Array.from(new Set(rows.map((r) => r.env_vars)));
  const testIds = Array.from(
    new Set(rows.filter((r) => r.test !== "0").map((r) => r.test))
  );
  const env = new Map(environmentIds.map((id, i) => [id, i]));
  const ev = new Map(envVarsIds.map((id, i) => [id, i]));
  const test = new Map(testIds.map((id, i) => [id, i]));
  const configs: CostCases["configs"] = [];
  const cells: CostCases["cells"] = [];
  let rankedOf = 0;
  for (const r of rows) {
    const counts = [
      Number(r.runs),
      Number(r.skipped),
      Number(r.failed),
      Number(r.reruns),
      Number(r.test_ms),
    ] as const;
    const side = Number(r.side);
    if (r.test === "0") {
      configs.push([
        side,
        env.get(r.environment) as number,
        ev.get(r.env_vars) as number,
        Number(r.tests),
        ...counts,
      ]);
    } else {
      rankedOf = Math.max(rankedOf, Number(r.ranked_of));
      cells.push([
        side,
        test.get(r.test) as number,
        env.get(r.environment) as number,
        ev.get(r.env_vars) as number,
        ...counts,
      ]);
    }
  }
  return { testIds, environmentIds, envVarsIds, configs, cells, rankedOf };
}

export async function getCostCases(
  params: CostCasesParams,
  now: Date = new Date()
): Promise<CostCases> {
  const a = parseDayRange(params.a);
  const b = parseDayRange(params.b);
  // The parameters' own check; here for the types.
  if (a === null || b === null) throw new Error("Invalid periods");
  const today = now.toISOString().slice(0, 10);
  const sideA = coveredSide(a, today);
  const sideB = coveredSide(b, today);
  const [aFrom, aEnd] = bounds(sideA, today);
  const [bFrom, bEnd] = bounds(sideB, today);
  const bound = {
    repo: params.repo,
    file: params.file,
    machine: params.machine,
    environment: params.environment ?? "",
    a_from: aFrom,
    a_end: aEnd,
    b_from: bFrom,
    b_end: bEnd,
  };
  const started = performance.now();
  const base = {
    repo: params.repo,
    file: params.file,
    machine: params.machine,
    environment: params.environment ?? null,
    a: sideA,
    b: sideB,
  };
  const covered = coveredDays(sideA, sideB);
  // The gate: test_cost and the tests catalog, a fraction of a second, not
  // heavy.
  const gateRows: GateRow[] =
    covered === 0
      ? []
      : await queryClickhouse(casesGateQuery(), bound, "tests_cost_cases_gate");
  const lanes = casesLanes(gateRows, covered);
  const empty = {
    environments: [],
    env_vars: [],
    tests: [],
    configs: [],
    cells: [],
    ranked_of: 0,
  };
  if (lanes.length === 0) {
    return {
      ...base,
      status: "ok",
      lanes,
      ...empty,
      query_duration_ms: Math.round(performance.now() - started),
    };
  }
  if (lanes.some((lane) => lane.tooBig)) {
    return {
      ...base,
      status: "too_big",
      lanes,
      ...empty,
      query_duration_ms: Math.round(performance.now() - started),
    };
  }
  const rows: ScanRow[] = await queryClickhouse(
    casesScanQuery(),
    { ...bound, a_days: sideA.covered_days, b_days: sideB.covered_days },
    "tests_cost_cases",
    false,
    CI_WORKLOAD_HEAVY
  );
  const compact = compactCases(rows);
  const [tests, environments, envVars]: [
    { id: string; suite: string; name: string }[],
    EnvironmentRow[],
    EnvVarsRow[]
  ] = await Promise.all([
    compact.testIds.length > 0
      ? queryClickhouse(
          casesTestsQuery(),
          { ids: compact.testIds },
          "tests_cost_cases_tests"
        )
      : Promise.resolve([]),
    queryClickhouse(environmentsQuery(), {}, "tests_cost_cases_envs"),
    compact.envVarsIds.length > 0
      ? queryClickhouse(
          casesEnvVarsQuery(),
          { ids: compact.envVarsIds },
          "tests_cost_cases_env_vars"
        )
      : Promise.resolve([]),
  ]);
  const testById = new Map(tests.map((t) => [t.id, t]));
  const envById = new Map(
    environments.map((r) => [r.environment_id_string, toEnvironment(r)])
  );
  const envVarsById = new Map(
    envVars.map((r) => [r.env_var_set_id_string, toEnvVars(r)])
  );
  return {
    ...base,
    status: "ok",
    lanes,
    environments: compact.environmentIds.map(
      (id) =>
        envById.get(id) ?? {
          ...UNKNOWN_ENVIRONMENT,
          id,
        }
    ),
    env_vars: compact.envVarsIds.map(
      (id) =>
        envVarsById.get(id) ?? {
          id,
          values: {},
          first_seen_at: EPOCH,
        }
    ),
    tests: compact.testIds.map(
      (id) => testById.get(id) ?? { id, suite: "", name: "" }
    ),
    configs: compact.configs,
    cells: compact.cells,
    ranked_of: compact.rankedOf,
    query_duration_ms: Math.round(performance.now() - started),
  };
}

const EPOCH = "1970-01-01T00:00:00.000Z";

// An environment the catalog lacks (never expected: the runs name catalog
// ids): every field empty.
const UNKNOWN_ENVIRONMENT = {
  os: "",
  os_version: "",
  cpu_architecture: "",
  cpu_capability: "",
  python_version: "",
  cc_compiler: "",
  cc_compiler_version: "",
  accelerator: "",
  accelerator_version: "",
  device_name: "",
  device_count: 0,
  first_seen_at: EPOCH,
};
