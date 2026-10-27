import { decodeRunsCursor } from "lib/api/tests/test/runs/cursor";
import { listRuns } from "lib/api/tests/test/runs/list";
import {
  RunListPageSchema,
  RunRecordSchema,
} from "lib/api/tests/test/runs/types";
import * as clickhouse from "lib/clickhouse";
import { entityRow } from "../../fixtures";
import {
  answerRunQueries,
  attemptRow,
  baseCursor,
  baseQuery,
  ENV_VARS_ID,
  ENVIRONMENT_ID,
  expandedRunRecord,
  groupedRunRecord,
  groupRow,
  RUN_OUTCOMES,
  runRecord,
  runRow,
  TEST_ID,
  workflowRow,
} from "./fixtures";

function catalogRow(overrides: Record<string, unknown> = {}) {
  return entityRow(1, ENVIRONMENT_ID, ENV_VARS_ID, {
    tests_id_string: TEST_ID,
    requested_tests_id_string: TEST_ID,
    has_test: 1,
    has_environment: 1,
    has_env_vars: 1,
    ...overrides,
  });
}

const attempts = [
  runRecord({ id: "00000000-0000-4000-8000-000000000001", outcome: "failed" }),
  runRecord({
    id: "00000000-0000-4000-8000-000000000002",
    outcome: "crashed",
    rerun_number: 1,
    started_at: "2026-10-19T16:29:00.000Z",
    ended_at: "2026-10-19T16:29:01.000Z",
  }),
  runRecord({
    id: "00000000-0000-4000-8000-000000000003",
    outcome: "passed",
    report_uuid: "00000000-0000-4000-8000-000000000002",
    rerun_number: 0,
    started_at: "2026-10-19T16:30:00.000Z",
    ended_at: "2026-10-19T16:30:01.000Z",
  }),
];

describe("test runs list", () => {
  let queryClickhouse: jest.SpyInstance;
  beforeEach(() => {
    queryClickhouse = jest.spyOn(clickhouse, "queryClickhouse");
    answerRunQueries(queryClickhouse);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test("bundles the initial execution and retries across reports even when the counter resets", async () => {
    answerRunQueries(queryClickhouse, {
      page: [groupRow()],
      attempts: [attempts[2], attempts[0], attempts[1]].map(attemptRow),
    });
    const page = await listRuns({ query: baseQuery, cursor: null });
    expect(page.runs).toEqual([groupedRunRecord(attempts)]);
    expect(Object.keys(page.runs[0]).sort()).toEqual([
      "attempts",
      "env_vars",
      "environment",
      "github_workflow",
      "owners",
      "test",
    ]);
    expect(
      page.runs[0].attempts.map((attempt) => attempt.rerun_number)
    ).toEqual([0, 1, 0]);
    expect(page.runs[0].attempts.map((attempt) => attempt.report.uuid)).toEqual(
      attempts.map((attempt) => attempt.report_uuid)
    );
    expect(RunListPageSchema.shape.runs.parse(page.runs)).toEqual(page.runs);
    expect(page.next_cursor).toBeNull();
  });

  test("orders timestamp ties by end time then execution UUID, independently of report and rerun number", async () => {
    const ordered = [
      runRecord({
        id: "00000000-0000-4000-8000-000000000001",
        rerun_number: 7,
      }),
      runRecord({
        id: "00000000-0000-4000-8000-000000000002",
        rerun_number: 0,
      }),
      runRecord({
        id: "00000000-0000-4000-8000-000000000000",
        ended_at: "2026-10-19T16:28:13.577Z",
        rerun_number: 1,
      }),
    ];
    answerRunQueries(queryClickhouse, {
      page: [groupRow()],
      attempts: [...ordered].reverse().map(attemptRow),
    });
    expect((await listRuns({ query: baseQuery, cursor: null })).runs).toEqual([
      groupedRunRecord(ordered),
    ]);
  });

  test("keeps every recorded outcome within the bundle, including skipped attempts", async () => {
    const records = RUN_OUTCOMES.map((outcome, rerun_number) =>
      runRecord({
        id: `00000000-0000-4000-8000-${String(rerun_number).padStart(12, "0")}`,
        outcome,
        rerun_number,
      })
    );
    answerRunQueries(queryClickhouse, {
      page: [groupRow()],
      attempts: records.map(attemptRow),
    });
    const page = await listRuns({
      query: { ...baseQuery, limit: 1 },
      cursor: null,
    });
    expect(page.runs).toEqual([groupedRunRecord(records)]);
    expect(page.runs[0].attempts.map((attempt) => attempt.outcome)).toEqual(
      RUN_OUTCOMES
    );
    expect(RunRecordSchema.parse(page.runs[0])).toEqual(page.runs[0]);
  });

  test("keeps distinct environments, env var sets and jobs separate when catalogs are missing", async () => {
    const records = [
      runRecord(),
      runRecord({ environments_id: "1" }),
      runRecord({ env_vars_id: "2" }),
      runRecord({ github_workflow_job_id: "3" }),
    ];
    answerRunQueries(queryClickhouse, {
      page: records.map((record) => groupRow(attemptRow(record))),
      attempts: [...records].reverse().map(attemptRow),
    });
    const page = await listRuns({
      query: { ...baseQuery, limit: 4 },
      cursor: null,
    });
    expect(page.runs).toEqual(records.map(expandedRunRecord));
    expect(
      page.runs.every(
        (run) =>
          run.test === null && run.environment === null && run.env_vars === null
      )
    ).toBe(true);
  });

  test("paginates complete bundles and enriches only the returned groups", async () => {
    const second = runRecord({ github_workflow_job_id: "2" });
    const lookahead = runRecord({
      tests_id: "123",
      environments_id: "8",
      github_workflow_job_id: "3",
    });
    answerRunQueries(queryClickhouse, {
      page: [
        groupRow(),
        groupRow({ ...attemptRow(second), sort_3: "2" }),
        groupRow({ ...attemptRow(lookahead), sort_1: "8", sort_3: "3" }),
      ],
      attempts: [...attempts, second].map(attemptRow),
    });
    const page = await listRuns({ query: baseQuery, cursor: null });
    expect(page.runs).toEqual([
      groupedRunRecord(attempts),
      expandedRunRecord(second),
    ]);
    expect(decodeRunsCursor(page.next_cursor!)).toEqual({
      ...baseCursor,
      direction: "next",
      position: { values: [...baseCursor.position.values.slice(0, -1), "2"] },
    });
    expect(queryClickhouse.mock.calls[0][1]).toEqual({
      test_id: TEST_ID,
      entries_limit: 3,
    });
    const queryParams = (id: string) =>
      queryClickhouse.mock.calls.find((call) => call[2] === id)![1];
    expect(JSON.stringify(queryParams("api_run_attempts"))).not.toContain(
      '"123"'
    );
    expect(JSON.stringify(queryParams("api_run_attempts"))).not.toContain(
      '"3"'
    );
    expect(queryParams("api_run_catalog")).toEqual({
      tests_ids: [TEST_ID],
      environments_ids: [ENVIRONMENT_ID],
      env_vars_ids: [ENV_VARS_ID],
    });
    expect(queryParams("api_run_workflow")).toEqual({
      github_workflow_job_ids: [attempts[0].github_workflow_job_id, "2"],
    });
    expect(queryClickhouse).toHaveBeenCalledTimes(4);

    queryClickhouse.mockClear();
    answerRunQueries(queryClickhouse, {
      page: [groupRow(attemptRow(lookahead))],
      attempts: [attemptRow(lookahead)],
    });
    const next = await listRuns({
      query: { ...baseQuery, limit: 1 },
      cursor: decodeRunsCursor(page.next_cursor!),
    });
    expect(next.runs).toEqual([expandedRunRecord(lookahead)]);
    expect(next.next_cursor).toBeNull();
  });

  test("an outcome filter selects a bundle without removing its later successful retry", async () => {
    answerRunQueries(queryClickhouse, {
      page: [groupRow()],
      attempts: attempts.map(attemptRow),
    });
    const page = await listRuns({
      query: { ...baseQuery, outcome: ["failed"] },
      cursor: null,
    });
    expect(page.runs).toEqual([groupedRunRecord(attempts)]);
    expect(queryClickhouse.mock.calls[0][1]).toHaveProperty("outcome", [
      "failed",
    ]);
    expect(
      queryClickhouse.mock.calls.find(
        (call) => call[2] === "api_run_attempts"
      )![1]
    ).not.toHaveProperty("outcome");
  });

  test.each([
    {
      name: "Python module",
      file: "test/dynamo/test_benchmark_runner.py",
      language: "python",
      prefix: "dynamo.test_benchmark_runner",
    },
    {
      name: "C++ binary",
      file: "cpp/test_api",
      language: "cpp",
      prefix: "cpp.test_api",
    },
  ])(
    "returns each attempt's source report URL for a $name",
    async ({ file, language, prefix }) => {
      const records = attempts.map((attempt) => ({
        ...attempt,
        github_workflow_job_id: "114912897697",
      }));
      answerRunQueries(queryClickhouse, {
        page: [groupRow({ github_workflow_job_id_string: "114912897697" })],
        attempts: records.map(attemptRow),
        catalog: [catalogRow({ file, language })],
        workflow: [
          workflowRow({
            github_workflow_job_id: "114912897697",
            github_workflow_run_id: "38278237839",
          }),
        ],
      });
      const page = await listRuns({ query: baseQuery, cursor: null });
      expect(page.runs[0].attempts.map((attempt) => attempt.report)).toEqual(
        records.map((attempt) => ({
          uuid: attempt.report_uuid,
          s3_url: `https://gha-artifacts.s3.amazonaws.com/torchci-reports/pytorch/pytorch/38278237839/114912897697/${prefix}-${attempt.report_uuid}.report.jsonl`,
        }))
      );
      expect(RunListPageSchema.shape.runs.parse(page.runs)).toEqual(page.runs);
    }
  );

  test.each([
    { name: "test catalog", catalog: { has_test: 0 } },
    { name: "workflow run ID", workflow: { github_workflow_run_id: null } },
    { name: "source filename", catalog: { file: "" } },
    {
      name: "recognized source filename",
      catalog: { file: "test/test_torch.txt" },
    },
    { name: "recognized language", catalog: { language: "unknown" } },
    { name: "repository", catalog: { repo: "" } },
    {
      name: "report UUID",
      run: { report_uuid: "00000000-0000-0000-0000-000000000000" },
    },
    {
      name: "positive workflow run ID",
      workflow: { github_workflow_run_id: "0" },
    },
    { name: "positive job ID", run: { github_workflow_job_id_string: "-1" } },
  ])(
    "retains report UUIDs without URLs when $name is unavailable",
    async ({ catalog, workflow, run }) => {
      const row = runRow({
        github_workflow_job_id_string: "114912897697",
        ...run,
      });
      answerRunQueries(queryClickhouse, {
        page: [groupRow(row)],
        attempts: [row],
        catalog: [catalogRow(catalog)],
        workflow: [
          workflowRow({
            github_workflow_job_id: row.github_workflow_job_id_string,
            github_workflow_run_id: "38278237839",
            ...workflow,
          }),
        ],
      });
      const page = await listRuns({ query: baseQuery, cursor: null });
      expect(page.runs[0].attempts[0].report).toEqual({
        uuid: row.report_uuid,
        s3_url: null,
      });
      expect(RunListPageSchema.shape.runs.parse(page.runs)).toEqual(page.runs);
    }
  );

  test.each([
    "api_test_runs_page",
    "api_run_attempts",
    "api_run_catalog",
    "api_run_workflow",
  ])("propagates %s failures", async (failingQuery) => {
    queryClickhouse.mockImplementation(async (_sql, _params, queryId) => {
      if (queryId === failingQuery) throw new Error("Database unavailable");
      if (queryId === "api_test_runs_page") return [groupRow()];
      return queryId === "api_run_attempts" ? [runRow()] : [];
    });
    await expect(listRuns({ query: baseQuery, cursor: null })).rejects.toThrow(
      "Database unavailable"
    );
  });

  test("sums query durations while catalog and workflow lookups overlap", async () => {
    jest.useFakeTimers();
    const durations: Record<string, number> = {
      api_test_runs_page: 37,
      api_run_attempts: 13,
      api_run_catalog: 11,
      api_run_workflow: 7,
    };
    queryClickhouse.mockImplementation(async (_sql, _params, queryId) => {
      await new Promise((resolve) => setTimeout(resolve, durations[queryId]));
      if (queryId === "api_test_runs_page") return [groupRow()];
      return queryId === "api_run_attempts" ? [runRow()] : [];
    });
    const startedAt = performance.now();
    const response = listRuns({ query: baseQuery, cursor: null });
    await jest.runAllTimersAsync();
    const page = await response;
    expect(page.query_duration_ms).toBe(68);
    expect(performance.now() - startedAt).toBe(61);
    expect(queryClickhouse.mock.calls.map((call) => call[2])).toEqual([
      "api_test_runs_page",
      "api_run_attempts",
      "api_run_catalog",
      "api_run_workflow",
    ]);
  });

  test("returns an empty continuation without fetching attempts or metadata", async () => {
    jest.useFakeTimers();
    queryClickhouse.mockImplementation(async () => {
      jest.advanceTimersByTime(37);
      return [];
    });
    expect(await listRuns({ query: baseQuery, cursor: baseCursor })).toEqual({
      runs: [],
      next_cursor: null,
      previous_cursor: null,
      query_duration_ms: 37,
    });
    expect(queryClickhouse).toHaveBeenCalledTimes(1);
  });
});
