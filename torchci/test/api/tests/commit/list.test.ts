import { decodeCommitRunsCursor } from "lib/api/tests/commit/cursor";
import { listCommitRuns } from "lib/api/tests/commit/list";
import { CommitRunsListQuery } from "lib/api/tests/commit/parameters";
import { CommitRunListPageSchema } from "lib/api/tests/commit/types";
import { EntityRow, toEntry } from "lib/api/tests/mapping";
import { listRuns } from "lib/api/tests/test/runs/list";
import { RunListPageSchema } from "lib/api/tests/test/runs/types";
import * as clickhouse from "lib/clickhouse";
import { entityRow } from "../fixtures";
import {
  answerRunQueries,
  attemptRow,
  ENV_VARS_ID,
  ENVIRONMENT_ID,
  expandedRunRecord,
  groupedRunRecord,
  groupRow,
  RUN_OUTCOMES,
  runRecord,
  runRow,
  runStats,
  STARTED_AT,
  TEST_ID,
  workflowRow,
} from "../test/runs/fixtures";

const query: CommitRunsListQuery = {
  sha: "0123456789abcdef0123456789abcdef01234567",
  repo: "pytorch/pytorch",
  sort: ["-started_at"],
  limit: 2,
};
function commitRow(overrides: Record<string, unknown> = {}) {
  return groupRow({
    sort_0: String(Date.parse(STARTED_AT)),
    sort_1: TEST_ID,
    sort_2: ENVIRONMENT_ID,
    sort_3: ENV_VARS_ID,
    sort_4: "-9223372036854775808",
    ...overrides,
  });
}
function catalogRow(overrides: Record<string, unknown> = {}) {
  return entityRow(1, ENVIRONMENT_ID, ENV_VARS_ID, {
    tests_id_string: TEST_ID,
    requested_tests_id_string: TEST_ID,
    has_test: 1,
    has_environment: 1,
    has_env_vars: 1,
    ...overrides,
  }) as EntityRow;
}

describe("commit run bundles", () => {
  let queryClickhouse: jest.SpyInstance;
  beforeEach(() => {
    queryClickhouse = jest.spyOn(clickhouse, "queryClickhouse");
    answerRunQueries(queryClickhouse);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test("returns the same shared catalogs, workflow and attempts as the test runs endpoint", async () => {
    const records = [
      runRecord({ github_workflow_job_id: "114912897697" }),
      runRecord({
        id: "00000000-0000-4000-8000-000000000001",
        github_workflow_job_id: "114912897697",
        rerun_number: 1,
        outcome: "passed",
        started_at: "2026-10-19T16:29:00.000Z",
        ended_at: "2026-10-19T16:29:01.000Z",
      }),
    ];
    const catalog = catalogRow({
      file: "test/dynamo/test_benchmark_runner.py",
    });
    const workflow = workflowRow({
      github_workflow_job_id: "114912897697",
      github_workflow_run_id: "38278237839",
    });
    answerRunQueries(queryClickhouse, {
      page: [commitRow({ github_workflow_job_id_string: "114912897697" })],
      attempts: records.map(attemptRow),
      catalog: [catalog],
      workflow: [workflow],
      stats: runStats(records.map((run) => run.outcome)),
    });
    const page = await listCommitRuns({ query, cursor: null });
    const { test, environment, env_vars, owners } = toEntry(catalog, {
      window: "7d",
      ran_on: ["main"],
    });
    expect(page.runs[0]).toMatchObject({
      test,
      environment,
      env_vars,
      owners,
      github_workflow: { job_id: "114912897697" },
    });
    expect(
      page.runs[0].attempts.map((attempt) => attempt.report.s3_url)
    ).toEqual(
      records.map(
        (run) =>
          `https://gha-artifacts.s3.amazonaws.com/torchci-reports/pytorch/pytorch/38278237839/114912897697/dynamo.test_benchmark_runner-${run.report_uuid}.report.jsonl`
      )
    );
    expect(page.stats).toEqual(runStats(["failed", "passed"]));
    expect(CommitRunListPageSchema.parse(page)).toEqual(page);
    const forTest = await listRuns({
      query: { test_id: TEST_ID, sort: query.sort, limit: 2 },
      cursor: null,
    });
    expect(forTest.runs).toEqual(page.runs);
    expect(forTest).not.toHaveProperty("stats");
  });

  test("keeps tests with the same environment and job separate even when catalogs are missing", async () => {
    const first = runRecord({ tests_id: "0" });
    const firstAttempt = runRecord({
      tests_id: "0",
      id: "00000000-0000-4000-8000-000000000001",
      outcome: "passed",
      started_at: "2026-10-19T16:29:00.000Z",
      ended_at: "2026-10-19T16:29:01.000Z",
    });
    const second = runRecord({ tests_id: "9007199254740993" });
    answerRunQueries(queryClickhouse, {
      page: [
        commitRow({ tests_id_string: "0", sort_1: "0" }),
        commitRow({
          tests_id_string: second.tests_id,
          sort_1: second.tests_id,
        }),
      ],
      attempts: [second, firstAttempt, first].map(attemptRow),
      stats: runStats(["failed", "passed", "failed"]),
    });
    const page = await listCommitRuns({ query, cursor: null });
    expect(page.runs).toEqual([
      groupedRunRecord([first, firstAttempt]),
      expandedRunRecord(second),
    ]);
    expect(page.stats.total).toBe(3);
    expect(page.runs).toHaveLength(2);
  });

  test("uses the last returned group for pagination and fetches no attempts from the lookahead", async () => {
    const first = runRecord({ tests_id: "1" });
    const second = runRecord({ tests_id: "2" });
    answerRunQueries(queryClickhouse, {
      page: [
        commitRow({ tests_id_string: "1", sort_1: "1" }),
        commitRow({ tests_id_string: "2", sort_1: "2" }),
        commitRow({ tests_id_string: "3", sort_1: "3" }),
      ],
      attempts: [first, second].map(attemptRow),
      stats: runStats(Array(17).fill("failed")),
    });
    const page = await listCommitRuns({ query, cursor: null });
    expect(page.runs).toEqual([
      expandedRunRecord(first),
      expandedRunRecord(second),
    ]);
    expect(decodeCommitRunsCursor(page.next_cursor!)).toEqual({
      version: 2,
      resource: "commit-runs",
      query: { repo: query.repo, sha: query.sha, sort: query.sort },
      position: {
        values: [
          String(Date.parse(STARTED_AT)),
          "2",
          ENVIRONMENT_ID,
          ENV_VARS_ID,
          "-9223372036854775808",
        ],
      },
    });
    const attemptParams = queryClickhouse.mock.calls.find(
      (call) => call[2] === "api_run_attempts"
    )![1];
    expect(JSON.stringify(attemptParams)).not.toContain('"3"');
    const firstStatsCall = queryClickhouse.mock.calls.find(
      (call) => call[2] === "api_commit_runs_stats"
    );
    queryClickhouse.mockClear();
    answerRunQueries(queryClickhouse, {
      stats: runStats(Array(17).fill("failed")),
    });
    const next = await listCommitRuns({
      query: { ...query, limit: 3 },
      cursor: decodeCommitRunsCursor(page.next_cursor!),
    });
    expect(next).toMatchObject({
      runs: [],
      next_cursor: null,
      stats: page.stats,
    });
    expect(
      queryClickhouse.mock.calls.find(
        (call) => call[2] === "api_commit_runs_stats"
      )
    ).toEqual(firstStatsCall);
    expect(queryClickhouse).toHaveBeenCalledTimes(2);
  });

  test("keeps execution statistics over the full commit when filters select a bundle", async () => {
    const failed = runRecord();
    const passed = runRecord({
      id: "00000000-0000-4000-8000-000000000001",
      rerun_number: 1,
      outcome: "passed",
      started_at: "2026-10-19T16:29:00.000Z",
      ended_at: "2026-10-19T16:29:01.000Z",
    });
    const stats = runStats([...RUN_OUTCOMES, "passed"]);
    answerRunQueries(queryClickhouse, {
      page: [commitRow()],
      attempts: [failed, passed].map(attemptRow),
      stats,
    });
    const filtered: CommitRunsListQuery = {
      ...query,
      outcome: ["failed"],
      rerun_number: [0],
      limit: 1,
    };
    const page = await listCommitRuns({ query: filtered, cursor: null });
    expect(page.runs).toEqual([groupedRunRecord([failed, passed])]);
    expect(page.stats).toEqual(stats);
    expect(
      queryClickhouse.mock.calls.find(
        (call) => call[2] === "api_commit_runs_stats"
      )![1]
    ).toEqual({ sha: query.sha, repo: query.repo });
  });

  test.each([
    {
      field: "test",
      absent: { has_test: 0, tests_id_string: "0", owners: ["unrelated"] },
    },
    {
      field: "environment",
      absent: { has_environment: 0, environment_id_string: "0" },
    },
    {
      field: "env_vars",
      absent: { has_env_vars: 0, env_var_set_id_string: "0" },
    },
  ] as const)(
    "preserves attempts and other catalog objects when $field is missing",
    async ({ field, absent }) => {
      answerRunQueries(queryClickhouse, {
        page: [commitRow()],
        attempts: [runRow()],
        catalog: [catalogRow(absent)],
      });
      const { runs } = await listCommitRuns({ query, cursor: null });
      expect(runs[0].attempts).toEqual(expandedRunRecord().attempts);
      expect(runs[0][field]).toBeNull();
      for (const other of ["test", "environment", "env_vars"] as const)
        if (other !== field) expect(runs[0][other]).not.toBeNull();
      expect(runs[0].owners).toEqual(field === "test" ? [] : ["core_tests"]);
      expect(RunListPageSchema.shape.runs.parse(runs)).toEqual(runs);
    }
  );

  test("expands catalog ID zero when the row exists", async () => {
    const row = {
      tests_id_string: "0",
      environments_id_string: "0",
      env_vars_id_string: "0",
    };
    answerRunQueries(queryClickhouse, {
      page: [commitRow(row)],
      attempts: [runRow(row)],
      catalog: [
        catalogRow({
          ...row,
          requested_tests_id_string: "0",
          environment_id_string: "0",
          env_var_set_id_string: "0",
        }),
      ],
    });
    const { runs } = await listCommitRuns({ query, cursor: null });
    expect(runs[0].test?.id).toBe("0");
    expect(runs[0].environment?.id).toBe("0");
    expect(runs[0].env_vars?.id).toBe("0");
  });

  test.each([
    "api_commit_runs_page",
    "api_run_attempts",
    "api_run_catalog",
    "api_run_workflow",
  ])("propagates %s failures", async (failingQuery) => {
    queryClickhouse.mockImplementation(async (_sql, _params, queryId) => {
      if (queryId === failingQuery) throw new Error("Database unavailable");
      if (queryId === "api_commit_runs_page") return [commitRow()];
      if (queryId === "api_run_attempts") return [runRow()];
      return queryId === "api_commit_runs_stats" ? [runStats()] : [];
    });
    await expect(listCommitRuns({ query, cursor: null })).rejects.toThrow(
      "Database unavailable"
    );
  });
  test("propagates stats failures instead of inventing totals", async () => {
    queryClickhouse.mockImplementation(async (_sql, _params, queryId) => {
      if (queryId === "api_commit_runs_stats")
        throw new Error("Stats unavailable");
      return [];
    });
    await expect(listCommitRuns({ query, cursor: null })).rejects.toThrow(
      "Stats unavailable"
    );
  });

  test.each(
    [
      [],
      [{}],
      [{ ...runStats(), total: -1 }],
      [{ ...runStats(), total: 1.5 }],
      [{ ...runStats(), total: "12" }],
      [{ ...runStats(), total: null }],
      [{ ...runStats(), total: Number.MAX_SAFE_INTEGER + 1 }],
    ].map((statsRows) => ({ statsRows }))
  )("rejects missing or invalid stats rows %j", async ({ statsRows }) => {
    queryClickhouse.mockImplementation(async (_sql, _params, queryId) =>
      queryId === "api_commit_runs_stats" ? statsRows : []
    );
    await expect(listCommitRuns({ query, cursor: null })).rejects.toThrow();
  });

  test.each(RUN_OUTCOMES)(
    "requires a valid count for the %s outcome",
    async (outcome) => {
      for (const value of [
        undefined,
        -1,
        1.5,
        "12",
        null,
        Number.MAX_SAFE_INTEGER + 1,
      ]) {
        queryClickhouse.mockImplementation(async (_sql, _params, queryId) =>
          queryId === "api_commit_runs_stats"
            ? [{ ...runStats(), [outcome]: value }]
            : []
        );
        await expect(listCommitRuns({ query, cursor: null })).rejects.toThrow();
      }
    }
  );

  test("requires stats in the response schema instead of the old flat count", () => {
    const oldPage = {
      runs: [],
      next_cursor: null,
      query_duration_ms: 0,
      total_runs: 0,
    };
    expect(CommitRunListPageSchema.safeParse(oldPage).success).toBe(false);
    expect(
      CommitRunListPageSchema.parse({ ...oldPage, stats: runStats() })
    ).not.toHaveProperty("total_runs");
  });

  test("requires the concise stats fields instead of the old suffixed counts", () => {
    const stats = runStats();
    const oldStats = Object.fromEntries(
      Object.entries(stats).map(([field, count]) => [`${field}_runs`, count])
    );
    const page = { runs: [], next_cursor: null, query_duration_ms: 0 };
    expect(
      CommitRunListPageSchema.safeParse({ ...page, stats: oldStats }).success
    ).toBe(false);
    expect(
      CommitRunListPageSchema.parse({
        ...page,
        stats: { ...oldStats, ...stats },
      }).stats
    ).toEqual(stats);
  });

  test("sums all query durations while statistics overlap the page and enrichment", async () => {
    jest.useFakeTimers();
    const durations: Record<string, number> = {
      api_commit_runs_page: 37,
      api_commit_runs_stats: 71,
      api_run_attempts: 13,
      api_run_catalog: 11,
      api_run_workflow: 7,
    };
    queryClickhouse.mockImplementation(async (_sql, _params, queryId) => {
      await new Promise((resolve) => setTimeout(resolve, durations[queryId]));
      if (queryId === "api_commit_runs_page") return [commitRow()];
      if (queryId === "api_run_attempts") return [runRow()];
      return queryId === "api_commit_runs_stats"
        ? [runStats(Array(17).fill("failed"))]
        : [];
    });
    const startedAt = performance.now();
    const response = listCommitRuns({ query, cursor: null });
    await jest.runAllTimersAsync();
    const page = await response;
    expect(page.query_duration_ms).toBe(139);
    expect(page.stats.total).toBe(17);
    expect(performance.now() - startedAt).toBe(71);
    expect(queryClickhouse).toHaveBeenCalledTimes(5);
  });

  test("reports database time for an empty commit without fetching attempts or metadata", async () => {
    jest.useFakeTimers();
    queryClickhouse.mockImplementation(async (_sql, _params, queryId) => {
      const isStats = queryId === "api_commit_runs_stats";
      await new Promise((resolve) => setTimeout(resolve, isStats ? 19 : 37));
      return isStats ? [runStats()] : [];
    });
    const response = listCommitRuns({ query, cursor: null });
    await jest.runAllTimersAsync();
    expect(await response).toEqual({
      runs: [],
      next_cursor: null,
      query_duration_ms: 56,
      stats: runStats(),
    });
    expect(queryClickhouse.mock.calls.map((call) => call[2])).toEqual([
      "api_commit_runs_page",
      "api_commit_runs_stats",
    ]);
  });
});
