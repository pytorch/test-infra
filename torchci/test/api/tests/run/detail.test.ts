import { getRun } from "lib/api/tests/run/detail";
import { RunDetailSchema } from "lib/api/tests/run/types";
import { listRuns } from "lib/api/tests/test/runs/list";
import { RunRecordSchema } from "lib/api/tests/test/runs/types";
import * as clickhouse from "lib/clickhouse";
import { entityRow } from "../fixtures";
import {
  answerRunQueries,
  attemptRow,
  baseQuery,
  ENV_VARS_ID,
  ENVIRONMENT_ID,
  expandedRunRecord,
  groupRow,
  RUN_ID,
  runRecord,
  runRow,
  TEST_ID,
  workflowRow,
} from "../test/runs/fixtures";

const JOB_ID = "114912897697";
const WORKFLOW_RUN_ID = "38278237839";
const REPORT_UUID = "ffe2a051-037b-44c1-8205-291c7bd84c1e";
function catalogRow(overrides: Record<string, unknown> = {}) {
  return entityRow(1, ENVIRONMENT_ID, ENV_VARS_ID, {
    requested_tests_id_string: TEST_ID,
    tests_id_string: TEST_ID,
    has_test: 1,
    has_environment: 1,
    has_env_vars: 1,
    owners: ["dynamo", "tests"],
    file: "test/dynamo/test_benchmark_runner.py",
    ...overrides,
  });
}

describe("run detail", () => {
  let queryClickhouse: jest.SpyInstance;
  beforeEach(() => {
    queryClickhouse = jest.spyOn(clickhouse, "queryClickhouse");
    answerRunQueries(queryClickhouse);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test("returns the same complete bundle and report links as the runs list", async () => {
    const records = [
      runRecord({ github_workflow_job_id: JOB_ID, report_uuid: REPORT_UUID }),
      runRecord({
        id: "00000000-0000-4000-8000-000000000002",
        github_workflow_job_id: JOB_ID,
        rerun_number: 0,
        outcome: "passed",
        started_at: "2026-10-19T16:29:00.000Z",
        ended_at: "2026-10-19T16:29:01.000Z",
      }),
    ];
    queryClickhouse.mockImplementation(async (_sql, params, queryId) => {
      if (queryId === "api_run_catalog") return [catalogRow()];
      if (queryId === "api_run_workflow")
        return [
          workflowRow({
            github_workflow_job_id: JOB_ID,
            github_workflow_run_id: WORKFLOW_RUN_ID,
            workflow_metadata_available: 1,
            workflow_repository_id: "65600975",
            workflow_event: "pull_request",
            workflow_pull_requests: [
              {
                number: 123,
                url: "https://api.github.com/repos/pytorch/pytorch/pulls/123",
                base_repository_id: "65600975",
              },
            ],
          }),
        ];
      if (queryId === "api_test_runs_page")
        return [groupRow({ github_workflow_job_id_string: JOB_ID })];
      if (queryId === "api_run_detail")
        return records
          .filter((run) => run.id === params.run_id)
          .map(attemptRow);
      if (queryId === "api_run_attempts")
        return [...records].reverse().map(attemptRow);
      throw new Error(`Unexpected query ${queryId}`);
    });
    const result = await getRun(RUN_ID);
    expect(result?.run).toMatchObject({
      test: { id: TEST_ID, file: "test/dynamo/test_benchmark_runner.py" },
      environment: { id: ENVIRONMENT_ID, device_name: "NVIDIA L4" },
      env_vars: { id: ENV_VARS_ID, values: { TEST_CONFIG: "default" } },
      owners: ["dynamo", "tests"],
      github_workflow: {
        job_id: JOB_ID,
        run_id: WORKFLOW_RUN_ID,
        path: ".github/workflows/pull.yml",
        commit_sha: "0123456789abcdef0123456789abcdef01234567",
        event: "pull_request",
        pull_request: {
          number: 123,
          url: "https://github.com/pytorch/pytorch/pull/123",
        },
      },
    });
    expect(result?.run.attempts.map((attempt) => attempt.id)).toEqual(
      records.map((run) => run.id)
    );
    expect(result?.run.attempts[0].report).toEqual({
      uuid: REPORT_UUID,
      s3_url: `https://gha-artifacts.s3.amazonaws.com/torchci-reports/pytorch/pytorch/${WORKFLOW_RUN_ID}/${JOB_ID}/dynamo.test_benchmark_runner-${REPORT_UUID}.report.jsonl`,
    });
    expect(Object.keys(result!).sort()).toEqual(["query_duration_ms", "run"]);
    expect(RunDetailSchema.parse(result)).toEqual(result);
    expect(result?.run.github_workflow).not.toHaveProperty("pull_requests");
    expect(queryClickhouse).toHaveBeenCalledTimes(4);
    // The detail reads one bundle: none of its queries, the attempts read
    // included, runs in the heavy workload.
    expect(queryClickhouse.mock.calls.map((call) => call[4])).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    const [sql, params, queryId] = queryClickhouse.mock.calls[0];
    expect(queryId).toBe("api_run_detail");
    expect(params).toEqual({ run_id: RUN_ID });
    expect(sql).not.toContain(RUN_ID);
    expect((await getRun(records[1].id))?.run).toEqual(result?.run);
    expect(
      (await listRuns({ query: baseQuery, cursor: null })).runs[0]
    ).toEqual(result?.run);
  });

  test("returns null for an absent run without fetching attempts or metadata", async () => {
    expect(await getRun(RUN_ID)).toBeNull();
    expect(queryClickhouse).toHaveBeenCalledTimes(1);
  });

  test("retains the bundle and report UUID when all metadata is unavailable", async () => {
    answerRunQueries(queryClickhouse, {
      detail: [runRow()],
      attempts: [runRow()],
    });
    const result = await getRun(RUN_ID);
    expect(result?.run).toEqual(expandedRunRecord());
    expect(result?.run.attempts[0].report.s3_url).toBeNull();
    expect(RunDetailSchema.parse(result)).toEqual(result);
    expect(queryClickhouse).toHaveBeenCalledTimes(4);
  });

  test("keeps available environment and job fields when other metadata is missing", async () => {
    const workflow = workflowRow({
      github_workflow_job_id: JOB_ID,
      github_workflow_run_id: WORKFLOW_RUN_ID,
      workflow_path: null,
      commit_sha: null,
    });
    const row = runRow({ github_workflow_job_id_string: JOB_ID });
    answerRunQueries(queryClickhouse, {
      detail: [row],
      attempts: [row],
      catalog: [catalogRow({ has_test: 0, has_env_vars: 0 })],
      workflow: [workflow],
    });
    const result = await getRun(RUN_ID);
    expect(result?.run).toMatchObject({
      test: null,
      environment: { id: ENVIRONMENT_ID },
      env_vars: null,
      owners: [],
      attempts: expandedRunRecord().attempts,
      github_workflow: {
        job_id: JOB_ID,
        run_id: WORKFLOW_RUN_ID,
        path: null,
        commit_sha: null,
        job_url: workflow.github_workflow_job_url,
        job_name: workflow.github_workflow_job_name,
        event: null,
        pull_request: null,
      },
    });
    expect(RunDetailSchema.parse(result)).toEqual(result);
  });

  test("rejects ambiguous UUID matches before fetching attempts or metadata", async () => {
    answerRunQueries(queryClickhouse, {
      detail: [runRow(), runRow({ tests_id_string: "123" })],
    });
    await expect(getRun(RUN_ID)).rejects.toThrow();
    expect(queryClickhouse).toHaveBeenCalledTimes(1);
  });

  test("returns null if the requested execution disappears before the complete group is read", async () => {
    answerRunQueries(queryClickhouse, {
      detail: [runRow()],
      attempts: [runRow({ id: "00000000-0000-4000-8000-000000000002" })],
    });
    expect(await getRun(RUN_ID)).toBeNull();
    expect(queryClickhouse.mock.calls.map((call) => call[2])).toEqual([
      "api_run_detail",
      "api_run_attempts",
    ]);
  });

  test.each([
    "api_run_detail",
    "api_run_attempts",
    "api_run_catalog",
    "api_run_workflow",
  ])("propagates a failed %s request", async (failingQuery) => {
    queryClickhouse.mockImplementation(async (_sql, _params, queryId) => {
      if (queryId === failingQuery) throw new Error("Database unavailable");
      return queryId === "api_run_detail" || queryId === "api_run_attempts"
        ? [runRow()]
        : [];
    });
    await expect(getRun(RUN_ID)).rejects.toThrow("Database unavailable");
  });

  test("sums database durations while catalog and workflow requests overlap", async () => {
    jest.useFakeTimers();
    const durations: Record<string, number> = {
      api_run_detail: 37,
      api_run_attempts: 13,
      api_run_catalog: 11,
      api_run_workflow: 7,
    };
    queryClickhouse.mockImplementation(async (_sql, _params, queryId) => {
      await new Promise((resolve) => setTimeout(resolve, durations[queryId]));
      return queryId === "api_run_detail" || queryId === "api_run_attempts"
        ? [runRow()]
        : [];
    });
    const startedAt = performance.now();
    const response = getRun(RUN_ID);
    await jest.runAllTimersAsync();
    expect((await response)?.query_duration_ms).toBe(68);
    expect(performance.now() - startedAt).toBe(61);
    expect(queryClickhouse.mock.calls.map((call) => call[2])).toEqual([
      "api_run_detail",
      "api_run_attempts",
      "api_run_catalog",
      "api_run_workflow",
    ]);
  });

  test("requires a nonempty attempt list with valid execution UUIDs", () => {
    const run = expandedRunRecord();
    for (const id of [undefined, null, "", "123", run.github_workflow.job_id]) {
      expect(
        RunRecordSchema.safeParse({
          ...run,
          attempts: [{ ...run.attempts[0], id }],
        }).success
      ).toBe(false);
    }
    expect(RunRecordSchema.safeParse({ ...run, attempts: [] }).success).toBe(
      false
    );
    expect(RunRecordSchema.parse(run).attempts[0].id).toBe(RUN_ID);
    expect(
      RunDetailSchema.safeParse({ run, query_duration_ms: -1 }).success
    ).toBe(false);
    expect(
      RunDetailSchema.safeParse({ run, query_duration_ms: 1.5 }).success
    ).toBe(false);
  });
});
