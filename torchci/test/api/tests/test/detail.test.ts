import { RAN_ONS, WINDOWS } from "lib/api/tests/parameters";
import { getTest } from "lib/api/tests/test/detail";
import { TestDetailSchema } from "lib/api/tests/test/types";
import * as clickhouse from "lib/clickhouse";
import {
  answerQueries,
  entityRow,
  getTests,
  REFRESHED_AT,
  testId,
  testRow,
} from "../fixtures";

// The routes are behind the GitHub gate, which has its own tests (auth.test.ts);
// here the handlers answer as themselves.
jest.mock("lib/api/auth", () => ({
  requireGithubWriteAccess: (handler: unknown) => handler,
}));

describe("test detail", () => {
  let queryClickhouse: jest.SpyInstance;

  beforeEach(() => {
    queryClickhouse = jest.spyOn(clickhouse, "queryClickhouse");
    answerQueries(queryClickhouse);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test("returns every window, source and configuration without the list's pagination limit", async () => {
    const rows = Array.from({ length: 5 }, (_, index) =>
      ["20", "21"].flatMap((envVarsId) =>
        WINDOWS.flatMap((window) =>
          RAN_ONS.map((ran_on) => ({
            ...entityRow(1, String(10 + index), envVarsId, {
              workflow_paths_combined: [`.github/workflows/${ran_on}.yml`],
            }),
            window,
            ran_on,
          }))
        )
      )
    ).flat();
    queryClickhouse.mockResolvedValueOnce(rows);

    const result = await getTest(testId(1));

    expect(result?.test).toEqual({
      id: testId(1),
      repo: "pytorch/pytorch",
      file: "test/test_torch.py",
      suite: "TestTorch",
      case_name: "test_case_0001",
      declared_case_name: "test_case",
      language: "python",
      first_seen_at: "2026-10-14T06:57:57.812Z",
    });
    expect(result?.owners).toEqual(["core_tests"]);
    expect(result?.health).toHaveLength(120);
    expect(
      result?.health.map(({ environment, env_vars, health }) => [
        environment?.id,
        env_vars?.id,
        health.window,
        health.ran_on,
        health.workflow_paths,
      ])
    ).toEqual(
      rows.map((row) => [
        row.environment_id_string,
        row.env_var_set_id_string,
        row.window,
        [row.ran_on],
        row.workflow_paths_combined,
      ])
    );
    expect(result).not.toHaveProperty("next_cursor");
    expect(result).not.toHaveProperty("next");
    expect(result?.refreshed_at).toBe(REFRESHED_AT);
    expect(TestDetailSchema.parse(result)).toEqual(result);
    expect(queryClickhouse).toHaveBeenCalledTimes(1);
  });

  test.each(
    WINDOWS.flatMap((window) => RAN_ONS.map((ran_on) => [window, ran_on]))
  )(
    "matches the list's configuration and health shapes for %s on %s",
    async (window, ran_on) => {
      const row = entityRow(1, "10", "20", {
        window,
        ran_on,
        owners: ["nn", "autograd"],
        workflow_paths_combined: [".github/workflows/pull.yml"],
      });
      queryClickhouse.mockResolvedValueOnce([row]);
      const result = await getTest(testId(1));

      answerQueries(queryClickhouse, { tests: [row] });
      const res = await getTests({ window, ran_on });

      expect(res.status).toBe(200);
      const { test: identity, owners, ...configuration } = res.body.tests[0];
      expect(result?.test).toEqual(identity);
      expect(result?.owners).toEqual(owners);
      expect(result?.health).toEqual([configuration]);
    }
  );

  test.each([REFRESHED_AT, null])(
    "returns known tests without health and includes the %s generation lookup in query timing",
    async (generation) => {
      jest.useFakeTimers();
      queryClickhouse
        .mockImplementationOnce(async () => {
          jest.advanceTimersByTime(23);
          return [testRow(1, { refreshed_at: "1970-01-01T00:00:00Z" })];
        })
        .mockImplementationOnce(async () => {
          jest.advanceTimersByTime(7);
          return generation === null ? [] : [{ refreshed_at: generation }];
        });

      const result = await getTest(testId(1));

      expect(result).toEqual({
        test: expect.objectContaining({ id: testId(1) }),
        owners: ["core_tests"],
        health: [],
        refreshed_at: generation,
        query_duration_ms: 30,
      });
      expect(TestDetailSchema.parse(result)).toEqual(result);
      expect(
        queryClickhouse.mock.calls.map(([, , queryId]) => queryId)
      ).toEqual(["api_test_detail", "api_tests_generation"]);
    }
  );

  test("returns null for an absent catalog test without reading the generation", async () => {
    queryClickhouse.mockResolvedValueOnce([]);

    expect(await getTest(testId(1))).toBeNull();
    expect(queryClickhouse).toHaveBeenCalledTimes(1);
    expect(queryClickhouse.mock.calls[0][2]).toBe("api_test_detail");
  });

  test("keeps skipped-only health and empty owners when configuration catalogs are missing", async () => {
    queryClickhouse.mockResolvedValueOnce([
      entityRow(1, "10", "20", {
        window: "3h",
        ran_on: "pull_request",
        owners: [],
        environment_id_string: "0",
        env_var_set_id_string: "0",
        runs_combined: 0,
        passed_runs_combined: 0,
        failed_runs_combined: 0,
        flaky_runs_combined: 0,
        skipped_runs_combined: 3,
        attempts_combined: 0,
        pass_rate: null,
        failure_rate: null,
        flaky_rate: null,
        skip_rate: 1,
        mean_passed_duration_milliseconds_combined: null,
        mean_duration_milliseconds_combined: null,
        total_duration_milliseconds_combined: 0,
        last_run_at_combined: null,
        last_failed_at_combined: null,
        workflow_paths_combined: [".github/workflows/pull.yml"],
        status: "skipped",
      }),
    ]);

    const result = await getTest(testId(1));

    expect(result?.owners).toEqual([]);
    expect(result?.health).toEqual([
      {
        environment: null,
        env_vars: null,
        health: {
          window: "3h",
          ran_on: ["pull_request"],
          workflow_paths: [".github/workflows/pull.yml"],
          status: "skipped",
          runs: 0,
          passed_runs: 0,
          failed_runs: 0,
          flaky_runs: 0,
          skipped_runs: 3,
          attempts: 0,
          pass_rate: null,
          failure_rate: null,
          flaky_rate: null,
          skip_rate: 1,
          mean_passed_duration_milliseconds: null,
          mean_duration_milliseconds: null,
          total_duration_milliseconds: 0,
          last_run_at: null,
          last_failed_at: null,
        },
      },
    ]);
    expect(result?.refreshed_at).toBe(REFRESHED_AT);
    expect(TestDetailSchema.parse(result)).toEqual(result);
    expect(queryClickhouse).toHaveBeenCalledTimes(1);
  });

  test("binds the full UInt64 ID and reports the health query's generation and timing", async () => {
    jest.useFakeTimers();
    const id = "18446744073709551615";
    const refreshedAt = "2026-10-22T18:00:00Z";
    queryClickhouse.mockImplementationOnce(async () => {
      jest.advanceTimersByTime(37);
      return [
        entityRow(1, "10", "20", {
          tests_id_string: id,
          window: "14d",
          ran_on: "main",
          refreshed_at: refreshedAt,
        }),
      ];
    });

    const result = await getTest(id);

    expect(result?.test.id).toBe(id);
    expect(result?.refreshed_at).toBe(refreshedAt);
    expect(result?.query_duration_ms).toBe(37);
    expect(queryClickhouse).toHaveBeenCalledTimes(1);
    const [sql, params, queryId] = queryClickhouse.mock.calls[0];
    expect(queryId).toBe("api_test_detail");
    expect(params).toEqual({ test_id: id });
    expect(sql).not.toContain(id);
    expect(sql).toContain("test.id = {test_id: UInt64}");
    expect(sql).toContain("tests_id = {test_id: UInt64}");
    expect(sql).toContain(
      "ORDER BY health.environments_id, health.env_vars_id,\n    health.window, health.ran_on"
    );
  });
});
