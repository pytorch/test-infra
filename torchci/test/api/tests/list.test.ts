import { decodeCursor, encodeCursor } from "lib/api/tests/cursor";
import {
  FILTER_DEFINITIONS,
  parseTestListParams,
} from "lib/api/tests/parameters";
import { buildListQuery } from "lib/api/tests/query";
import { searchPredicateSql } from "lib/api/tests/shared-sql";
import * as clickhouse from "lib/clickhouse";
import {
  answerQueries,
  baseCursor,
  callsOf,
  entityRow,
  getTests,
  LAST_FAILED_AT,
  MEAN_PASSED_DURATION_MILLISECONDS,
  REFRESHED_AT,
  testId,
} from "./fixtures";

// The routes are behind the GitHub gate, which has its own tests (auth.test.ts);
// here the handlers answer as themselves.
jest.mock("lib/api/auth", () => ({
  requireGithubWriteAccess: (handler: unknown) => handler,
}));

describe("test list", () => {
  let queryClickhouse: jest.SpyInstance;

  beforeEach(() => {
    queryClickhouse = jest.spyOn(clickhouse, "queryClickhouse");
    answerQueries(queryClickhouse);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test("returns environment and env vars with health for each observed configuration", async () => {
    answerQueries(queryClickhouse, {
      tests: [
        entityRow(1, "10", "20", {
          runs_combined: 100,
          passed_runs_combined: 90,
          failed_runs_combined: 10,
          pass_rate: 0.9,
          failure_rate: 0.1,
          workflow_paths_combined: [
            ".github/workflows/linux-test.yml",
            ".github/workflows/pull.yml",
          ],
        }),
        entityRow(2, "11", "21", { owners: [] }),
      ],
    });
    const res = await getTests({ ran_on: "main,pull_request", window: "7d" });
    expect(res.status).toBe(200);
    expect(res.body.tests.map((entry: any) => entry.test.id)).toEqual([
      testId(1),
      testId(2),
    ]);
    expect(Object.keys(res.body.tests[0]).sort()).toEqual([
      "env_vars",
      "environment",
      "health",
      "owners",
      "test",
    ]);
    expect(res.body.tests[0].health).toMatchObject({
      ran_on: ["main", "pull_request"],
      window: "7d",
      runs: 100,
      failure_rate: 0.1,
      workflow_paths: [
        ".github/workflows/linux-test.yml",
        ".github/workflows/pull.yml",
      ],
    });
    expect(res.body.tests[0].environment).toMatchObject({
      id: "10",
      os: "linux",
      cpu_architecture: "x86_64",
      accelerator: "cuda",
    });
    expect(res.body.tests[0].env_vars).toMatchObject({
      id: "20",
      values: { TEST_CONFIG: "default" },
    });
    expect(res.body.tests[1]).toMatchObject({
      environment: { id: "11" },
      env_vars: { id: "21" },
      health: { runs: 8, workflow_paths: [] },
      owners: [],
    });
    expect(res.body.pagination.next).toBeNull();
    expect(res.body.refreshed_at).toBe(REFRESHED_AT);
    expect(callsOf(queryClickhouse, "tests")).toHaveLength(1);
    expect(callsOf(queryClickhouse, "generation")).toHaveLength(0);
    expect(queryClickhouse).toHaveBeenCalledTimes(1);
  });

  test("returns an empty page when no configurations have health observations", async () => {
    answerQueries(queryClickhouse, { generation: [] });
    const res = await getTests();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      tests: [],
      pagination: { next: null, previous: null },
      refreshed_at: null,
      query_duration_ms: expect.any(Number),
    });
  });

  test("workflow filtering retains combined health and pages only the same normalized path selection", async () => {
    const pull = ".github/workflows/pull.yml";
    const nightly = ".github/workflows/nightly.yml";
    const allPaths = [pull, ".github/workflows/trunk.yml"];
    answerQueries(queryClickhouse, {
      tests: [
        entityRow(1, "10", "20", { workflow_paths_combined: allPaths }),
        entityRow(2, "10", "20", { workflow_paths_combined: allPaths }),
      ],
    });
    const first = await getTests({
      workflow_path: [pull, nightly],
      ran_on: "main,pull_request",
      limit: "1",
    });
    expect(first.status).toBe(200);
    expect(first.body.tests[0].health).toMatchObject({
      workflow_paths: allPaths,
      ran_on: ["main", "pull_request"],
      runs: 8,
      failed_runs: 2,
    });
    expect(
      decodeCursor(first.body.pagination.next.cursor)?.query.workflow_path
    ).toEqual([nightly, pull]);

    queryClickhouse.mockClear();
    answerQueries(queryClickhouse, {
      tests: [entityRow(2, "10", "20", { workflow_paths_combined: allPaths })],
    });
    const next = await getTests({
      workflow_path: [nightly, pull, nightly],
      ran_on: "pull_request,main",
      cursor: first.body.pagination.next.cursor,
    });
    expect(next.status).toBe(200);
    expect(next.body.tests[0].health.workflow_paths).toEqual(allPaths);
    expect(queryClickhouse).toHaveBeenCalledTimes(2);
    expect(callsOf(queryClickhouse, "boundary")[0][1].entries_limit).toBe(1);
    expect(
      callsOf(queryClickhouse, "tests")[0][1].filter_workflow_path
    ).toEqual([nightly, pull]);

    for (const workflow_path of [[pull], undefined]) {
      queryClickhouse.mockClear();
      const incompatible = await getTests({
        workflow_path,
        ran_on: "main,pull_request",
        cursor: first.body.pagination.next.cursor,
      });
      expect(incompatible.status).toBe(400);
      expect(incompatible.body.error).toMatch(/different/i);
      expect(queryClickhouse).not.toHaveBeenCalled();
    }
  });

  test("preserves database ordering and resumes a multi-key page with a different page size", async () => {
    const sort = "-failure_rate,-runs,case_name";
    answerQueries(queryClickhouse, {
      tests: [
        entityRow(3, "10", "20", {
          sort_0: 0.5,
          sort_1: "100",
          sort_2: "test_case_0003",
          sort_3: testId(3),
          sort_4: "10",
          sort_5: "20",
        }),
        entityRow(1, "10", "20", {
          workflow_paths_combined: [".github/workflows/pull.yml"],
          sort_0: 0.5,
          sort_1: "8",
          sort_2: "test_case_0001",
          sort_3: testId(1),
          sort_4: "10",
          sort_5: "20",
        }),
        entityRow(2, "10", "20", {
          sort_0: 0.5,
          sort_1: "8",
          sort_2: "test_case_0002",
          sort_3: testId(2),
          sort_4: "10",
          sort_5: "20",
        }),
      ],
    });
    const first = await getTests({ sort, limit: "2", owner: ["b", "a"] });
    expect(first.status).toBe(200);
    expect(first.body.tests.map((entry: any) => entry.test.id)).toEqual([
      testId(3),
      testId(1),
    ]);
    const cursor = decodeCursor(first.body.pagination.next.cursor);
    expect(cursor).toMatchObject({
      resource: "tests",
      generation: REFRESHED_AT,
      query: {
        sort: ["-failure_rate", "-runs", "case_name"],
        owner: ["a", "b"],
      },
      position: {
        values: [0.5, "8", "test_case_0001", testId(1), "10", "20"],
      },
    });
    expect(cursor?.query).not.toHaveProperty("limit");
    expect(first.body.tests[1].health.workflow_paths).toEqual([
      ".github/workflows/pull.yml",
    ]);

    queryClickhouse.mockClear();
    answerQueries(queryClickhouse, { tests: [entityRow(2)] });
    const next = await getTests({
      sort,
      limit: "1",
      owner: ["a", "b", "a"],
      cursor: first.body.pagination.next.cursor,
    });
    expect(next.status).toBe(200);
    expect(next.body.tests.map((entry: any) => entry.test.id)).toEqual([
      testId(2),
    ]);
    expect(next.body.pagination.next).toBeNull();
    expect(next.body.tests[0].health.workflow_paths).toEqual([]);
    expect(callsOf(queryClickhouse, "tests")[0][1]).toMatchObject({
      entries_limit: 2,
      cursor_0: 0.5,
      cursor_1: "8",
      cursor_2: "test_case_0001",
      cursor_3: testId(1),
      cursor_4: "10",
      cursor_5: "20",
    });
  });

  test.each(["-failure_rate", "-last_run_at"])(
    "resumes within null %s values using all configuration identities",
    async (sort) => {
      answerQueries(queryClickhouse, {
        tests: [
          entityRow(1, "10", "20", {
            failure_rate: null,
            last_run_at_combined: null,
            sort_0: null,
            sort_1: testId(1),
            sort_2: "10",
            sort_3: "20",
          }),
          entityRow(2, "10", "20", {
            failure_rate: null,
            last_run_at_combined: null,
            sort_0: null,
            sort_1: testId(2),
            sort_2: "10",
            sort_3: "20",
          }),
        ],
      });
      const first = await getTests({ sort, limit: "1" });
      expect(
        decodeCursor(first.body.pagination.next.cursor)?.position.values
      ).toEqual([null, testId(1), "10", "20"]);
      queryClickhouse.mockClear();
      answerQueries(queryClickhouse, {
        tests: [
          entityRow(2, "10", "20", {
            failure_rate: null,
            last_run_at_combined: null,
            sort_0: null,
            sort_1: testId(2),
            sort_2: "10",
            sort_3: "20",
          }),
        ],
      });
      const next = await getTests({
        sort,
        cursor: first.body.pagination.next.cursor,
      });
      expect(next.status).toBe(200);
      const [[sql, params]] = callsOf(queryClickhouse, "tests");
      expect(params).not.toHaveProperty("cursor_0");
      expect(params.cursor_1).toBe(testId(1));
      expect(sql).toContain("isNull(key_0)");
    }
  );

  test.each(["language", "-language"])(
    "uses language labels for both ordering and cursor comparisons: %s",
    async (sort) => {
      answerQueries(queryClickhouse, {
        tests: [
          entityRow(1, "10", "20", {
            language: "cpp",
            sort_0: "cpp",
            sort_1: testId(1),
            sort_2: "10",
            sort_3: "20",
          }),
          entityRow(2, "10", "20", {
            sort_0: "python",
            sort_1: testId(2),
            sort_2: "10",
            sort_3: "20",
          }),
        ],
      });
      const first = await getTests({ sort, limit: "1" });
      expect(
        decodeCursor(first.body.pagination.next.cursor)?.position.values
      ).toEqual(["cpp", testId(1), "10", "20"]);

      queryClickhouse.mockClear();
      answerQueries(queryClickhouse);
      const next = await getTests({
        sort,
        cursor: first.body.pagination.next.cursor,
      });
      expect(next.status).toBe(200);
      const [[sql, params]] = callsOf(queryClickhouse, "tests");
      // ClickHouse Enum8 ordering follows numeric enum values unless cast.
      expect(sql).toContain("toString(language) AS key_0");
      expect(sql).toContain("{cursor_0: String}");
      expect(params.cursor_0).toBe("cpp");
    }
  );

  test("keeps environments and env-var sets distinct across test pages", async () => {
    answerQueries(queryClickhouse, {
      tests: [
        entityRow(1, "10", "20"),
        entityRow(1, "11", "20"),
        entityRow(1, "11", "21"),
      ],
    });
    const res = await getTests({ case_name: "test_case_0001", limit: "2" });
    expect(res.status).toBe(200);
    expect(
      res.body.tests.map((entry: any) => [
        entry.test.id,
        entry.environment.id,
        entry.env_vars.id,
      ])
    ).toEqual([
      [testId(1), "10", "20"],
      [testId(1), "11", "20"],
    ]);
    expect(decodeCursor(res.body.pagination.next.cursor)).toMatchObject({
      resource: "tests",
      position: {
        values: [
          "2",
          0.25,
          "2",
          Date.parse(LAST_FAILED_AT),
          0.2,
          String(MEAN_PASSED_DURATION_MILLISECONDS),
          testId(1),
          "11",
          "20",
        ],
      },
    });
    expect(callsOf(queryClickhouse, "tests")[0][1].filter_case_name).toEqual([
      "test_case_0001",
    ]);

    queryClickhouse.mockClear();
    answerQueries(queryClickhouse, {
      tests: [entityRow(1, "11", "21")],
    });
    const next = await getTests({
      case_name: "test_case_0001",
      limit: "2",
      cursor: res.body.pagination.next.cursor,
    });
    expect(next.status).toBe(200);
    expect(next.body.tests).toHaveLength(1);
    expect(next.body.tests[0]).toMatchObject({
      test: { id: testId(1) },
      environment: { id: "11" },
      env_vars: { id: "21" },
    });
    expect(next.body.pagination.next).toBeNull();
    const [[sql, params]] = callsOf(queryClickhouse, "tests");
    expect(params).toMatchObject({
      cursor_0: "2",
      cursor_1: 0.25,
      cursor_2: "2",
      cursor_3: Date.parse(LAST_FAILED_AT),
      cursor_4: 0.2,
      cursor_5: String(MEAN_PASSED_DURATION_MILLISECONDS),
      cursor_6: testId(1),
      cursor_7: "11",
      cursor_8: "20",
    });
    expect(sql).toContain("key_0 < {cursor_0: UInt64}");
    expect(sql).toContain("key_3 < {cursor_3: Float64}");
    expect(sql).toContain("key_7 = {cursor_7: UInt64}");
    expect(sql).toContain("key_8 > {cursor_8: UInt64}");
  });

  test("keeps observed configurations when optional catalog records are missing", async () => {
    const environmentId = "18446744073709551615";
    const envVarsIds = ["18446744073709551613", "18446744073709551614"];
    answerQueries(queryClickhouse, {
      tests: envVarsIds.map((envVarsId) =>
        entityRow(1, environmentId, envVarsId, {
          environment_id_string: "0",
          env_var_set_id_string: "0",
        })
      ),
    });
    const res = await getTests();
    expect(res.status).toBe(200);
    expect(res.body.tests).toHaveLength(2);
    for (const entry of res.body.tests) {
      expect(entry).toMatchObject({
        test: { id: testId(1) },
        environment: null,
        env_vars: null,
        health: { runs: 8 },
      });
      expect(entry).not.toHaveProperty("environment_id");
      expect(entry).not.toHaveProperty("env_vars_id");
    }
  });

  test("continues across refreshes using the old position and the new page generation", async () => {
    answerQueries(queryClickhouse, {
      tests: [entityRow(1, "10", "20"), entityRow(2, "10", "20")],
    });
    const first = await getTests({ limit: "1" });
    expect(first.status).toBe(200);
    expect(decodeCursor(first.body.pagination.next.cursor)?.generation).toBe(
      REFRESHED_AT
    );

    const refreshedAt = "2026-10-19T18:00:00Z";
    const nextMeanPassedDuration = 900;
    queryClickhouse.mockClear();
    answerQueries(queryClickhouse, {
      tests: [
        entityRow(2, "10", "20", {
          refreshed_at: refreshedAt,
          mean_passed_duration_milliseconds_combined: nextMeanPassedDuration,
          sort_5: String(nextMeanPassedDuration),
        }),
        entityRow(3, "10", "20", {
          refreshed_at: refreshedAt,
          mean_passed_duration_milliseconds_combined: nextMeanPassedDuration,
          sort_5: String(nextMeanPassedDuration),
        }),
      ],
    });
    const next = await getTests({
      cursor: first.body.pagination.next.cursor,
      limit: "1",
    });
    expect(next.status).toBe(200);
    expect(next.body.tests.map((entry: any) => entry.test.id)).toEqual([
      testId(2),
    ]);
    expect(next.body.refreshed_at).toBe(refreshedAt);
    expect(decodeCursor(next.body.pagination.next.cursor)).toMatchObject({
      generation: refreshedAt,
      position: {
        values: [
          "2",
          0.25,
          "2",
          Date.parse(LAST_FAILED_AT),
          0.2,
          String(nextMeanPassedDuration),
          testId(2),
          "10",
          "20",
        ],
      },
    });
    expect(queryClickhouse).toHaveBeenCalledTimes(2);
    const [[sql, params]] = callsOf(queryClickhouse, "tests");
    expect(params).toMatchObject({
      cursor_0: "2",
      cursor_1: 0.25,
      cursor_2: "2",
      cursor_3: Date.parse(LAST_FAILED_AT),
      cursor_4: 0.2,
      cursor_5: String(MEAN_PASSED_DURATION_MILLISECONDS),
      cursor_6: testId(1),
      cursor_7: "10",
      cursor_8: "20",
    });
    expect(sql).toContain("key_0 < {cursor_0: UInt64}");
  });

  test("answers a cursorless page from its generation without extra queries", async () => {
    jest.useFakeTimers();
    const refreshedAt = "2026-10-19T18:00:00Z";
    queryClickhouse.mockImplementation(async () => {
      jest.advanceTimersByTime(37);
      return [entityRow(1, "10", "20", { refreshed_at: refreshedAt })];
    });
    const res = await getTests();
    expect(res.status).toBe(200);
    expect(res.body.tests).toHaveLength(1);
    expect(res.body.refreshed_at).toBe(refreshedAt);
    expect(res.body.query_duration_ms).toBe(37);
    expect(queryClickhouse).toHaveBeenCalledTimes(1);
    expect(callsOf(queryClickhouse, "generation")).toHaveLength(0);
  });

  test("returns an empty continuation after a refresh with observed generation metadata", async () => {
    jest.useFakeTimers();
    const refreshedAt = "2026-10-19T18:00:00Z";
    queryClickhouse
      .mockImplementationOnce(async () => {
        jest.advanceTimersByTime(23);
        return [];
      })
      .mockImplementationOnce(async () => {
        jest.advanceTimersByTime(7);
        return [{ refreshed_at: refreshedAt }];
      });
    const res = await getTests({ cursor: encodeCursor(baseCursor) });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      tests: [],
      pagination: { next: null, previous: null },
      refreshed_at: refreshedAt,
      query_duration_ms: 30,
    });
    expect(queryClickhouse.mock.calls.map(([, , queryId]) => queryId)).toEqual([
      "api_tests_page",
      "api_tests_generation",
    ]);
    expect(callsOf(queryClickhouse, "tests")[0][1]).toMatchObject({
      cursor_0: baseCursor.position.values[0],
      cursor_1: baseCursor.position.values[1],
      cursor_2: baseCursor.position.values[2],
      cursor_3: baseCursor.position.values[3],
    });
  });

  test("reports the data generation even when no tests match", async () => {
    const res = await getTests({ search: "no_such_test" });
    expect(res.body).toEqual({
      tests: [],
      pagination: { next: null, previous: null },
      refreshed_at: REFRESHED_AT,
      query_duration_ms: expect.any(Number),
    });
  });
});

describe("test list query boundaries", () => {
  function query(raw: Record<string, string | string[]> = {}) {
    const parsed = parseTestListParams({ repo: "pytorch/pytorch", ...raw });
    if (!parsed.success) throw parsed.error;
    const { cursor: _cursor, ...params } = parsed.data;
    return buildListQuery(params, null);
  }

  test("every centrally registered filter accepts multiple distinct values in its SQL binding", () => {
    // Values every filter's schema accepts, in canonical order: the enum
    // filters take only their own values.
    const samples: Record<string, string[]> = { status: ["failing", "flaky"] };
    for (const [name, definition] of Object.entries(FILTER_DEFINITIONS)) {
      const values =
        samples[name] ??
        (definition.type === "String" ? ["cpp", "python"] : ["1", "2"]);
      const { sql, params } = query({
        [name]: [values[1], values[0], values[1]],
      });
      const boundValues = definition.type === "UInt8" ? [1, 2] : values;
      expect(params).toHaveProperty(`filter_${name}`, boundValues);
      expect(sql).toContain(`{filter_${name}:`);
    }
  });

  test("binds exact values and environment-variable keys rather than inserting them into SQL", () => {
    const exactName = "test_[a,b]' OR 1=1 --";
    const exactPath = ".github/workflows/test' OR 1=1 --.yml";
    const { sql, params } = query({
      search: exactName,
      owner: ["nn", "autograd"],
      file: ["test/test_torch.py", "test/test_nn.py"],
      os: ["windows", "linux"],
      accelerator: ["cpu", "cuda"],
      cpu_architecture: "x86_64",
      workflow_path: [
        exactPath,
        ".github/workflows/a,b.yml",
        " .github/workflows/Pull.yml ",
      ],
      "env_vars[CUDA_VISIBLE_DEVICES]": ["0,1", ""],
    });
    expect(sql).not.toContain(exactName);
    expect(sql).not.toContain(exactPath);
    expect(sql).toContain(searchPredicateSql("test"));
    expect(params).toMatchObject({
      search: exactName,
      filter_owner: ["autograd", "nn"],
      filter_file: ["test/test_nn.py", "test/test_torch.py"],
      filter_os: ["linux", "windows"],
      filter_accelerator: ["cpu", "cuda"],
      filter_cpu_architecture: ["x86_64"],
      filter_workflow_path: [
        " .github/workflows/Pull.yml ",
        ".github/workflows/a,b.yml",
        exactPath,
      ],
      env_var_name_0: "CUDA_VISIBLE_DEVICES",
      env_var_values_0: ["", "0,1"],
    });
    expect(sql).toContain("mapContains");
    // Each field matches any supplied option, while different fields remain
    // separate constraints on the same test or environment.
    expect(sql).toContain("AND test.file IN {filter_file: Array(String)}");
    expect(sql).toContain(
      "AND hasAny(owner.owners, {filter_owner: Array(String)})"
    );
    expect(sql).toContain(
      "WHERE environment.os IN {filter_os: Array(String)} AND environment.cpu_architecture IN {filter_cpu_architecture: Array(String)} AND environment.accelerator IN {filter_accelerator: Array(String)}"
    );
  });

  test("reads the test config out of the env vars map for its filter and its sort", () => {
    const { sql, params } = query({
      test_config: ["slow", "default"],
      sort: "-test_config,last_run_at",
    });
    expect(params.filter_test_config).toEqual(["default", "slow"]);
    const envVars = sql.slice(sql.indexOf("env_vars_id IN ("));
    expect(envVars).toContain(
      "WHERE env_var_set.env_vars['TEST_CONFIG'] IN {filter_test_config: Array(String)}"
    );
    expect(sql).toContain("env_vars['TEST_CONFIG'] AS key_0");
    expect(sql).toContain(
      "toUnixTimestamp64Milli(last_run_at_combined) AS key_1"
    );
  });

  test("filters by health status once the sources are combined and sorts by its rank", () => {
    const { sql, params } = query({
      status: ["flaky", "failing"],
      sort: "-status,-failure_rate",
    });
    expect(params.filter_status).toEqual(["failing", "flaky"]);
    // The status is known only once the sources are combined, so the filter
    // applies to the combined rows, as the workflow path filter does.
    const result = sql.slice(sql.indexOf("FROM combined_health AS health"));
    expect(result).toContain(
      "WHERE health.status IN {filter_status: Array(String)}"
    );
    expect(sql).toContain("status_rank AS key_0");
    expect(sql).toContain("failure_rate AS key_1");
    expect(sql).toContain("toString(key_0) AS sort_0");
  });

  test("applies configuration conditions before aggregating sources and paginating", () => {
    const { sql } = query({
      accelerator: "cpu",
      "env_vars[TEST_CONFIG]": "default",
    });
    const health = sql.slice(sql.indexOf("combined_health AS"));
    const grouping = health.indexOf(
      "GROUP BY tests_id, environments_id, env_vars_id"
    );
    expect(grouping).toBeGreaterThan(0);
    expect(health.indexOf("environments_id IN")).toBeLessThan(grouping);
    expect(health.indexOf("env_vars_id IN")).toBeLessThan(grouping);
    expect(health.indexOf("LIMIT {entries_limit:")).toBeGreaterThan(grouping);
    expect(sql).toContain(
      "FROM combined_health AS health\n        INNER JOIN catalog"
    );
    expect(query().sql).toContain(
      "FROM combined_health AS health\n        INNER JOIN catalog"
    );
  });
});
