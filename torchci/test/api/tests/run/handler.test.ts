import { GET } from "app/api/tests/run/[run_id]/route";
import type { RawQuery } from "lib/api/parameters";
import { ErrorResponseSchema } from "lib/api/schema";
import * as detail from "lib/api/tests/run/detail";
import { RunDetail, RunDetailSchema } from "lib/api/tests/run/types";
import { callRoute } from "test/api/routes";
import { expandedRunRecord, RUN_ID } from "../test/runs/fixtures";

const runDetail: RunDetail = {
  run: expandedRunRecord(),
  query_duration_ms: 5,
};

function get(query: RawQuery = { run_id: RUN_ID }) {
  return callRoute(GET, "/api/tests/run/{run_id}", query);
}

describe("app/api/tests/run/[run_id]", () => {
  let getRun: jest.SpyInstance;

  beforeEach(() => {
    getRun = jest.spyOn(detail, "getRun").mockResolvedValue(runDetail);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test.each([
    {},
    { id: RUN_ID },
    { run_id: undefined },
    { run_id: "" },
    { run_id: "12345" },
    { run_id: RUN_ID.replaceAll("-", "") },
    { run_id: `{${RUN_ID}}` },
    { run_id: `urn:uuid:${RUN_ID}` },
    { run_id: ` ${RUN_ID}` },
    { run_id: `${RUN_ID} ` },
    { run_id: `${RUN_ID}0` },
    { run_id: RUN_ID.replace("0199", "g199") },
    { run_id: "' OR 1 = 1 --" },
    { run_id: [RUN_ID] },
    { run_id: [RUN_ID, RUN_ID] },
    { run_id: RUN_ID, repo: "pytorch/pytorch" },
    { run_id: RUN_ID, test_id: "123" },
    { run_id: RUN_ID, report_uuid: RUN_ID },
    { run_id: RUN_ID, limit: "1" },
    { run_id: RUN_ID, cursor: "anything" },
    { run_id: RUN_ID, outcome: "passed" },
  ])(
    "rejects invalid or unsupported parameters before querying %j",
    async (query) => {
      const res = await get(query);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("invalid_parameters");
      expect(res.body.issues.length).toBeGreaterThan(0);
      expect(ErrorResponseSchema.parse(res.body)).toEqual(res.body);
      expect(getRun).not.toHaveBeenCalled();
    }
  );

  test.each([
    RUN_ID,
    RUN_ID.toUpperCase(),
    "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-0000-0000-000000000000",
    "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF",
  ])(
    "accepts UUID %s and passes its lowercase form to the lookup",
    async (id) => {
      getRun.mockResolvedValue({
        ...runDetail,
        run: expandedRunRecord({ id: id.toLowerCase() }),
      });
      const res = await get({ run_id: id });
      expect(res.status).toBe(200);
      expect(getRun).toHaveBeenCalledTimes(1);
      expect(getRun).toHaveBeenCalledWith(id.toLowerCase());
      expect(RunDetailSchema.parse(res.body)).toEqual(res.body);
      expect(res.body.run.attempts[0].id).toBe(id.toLowerCase());
    }
  );

  test("returns a run without catalogs or workflow metadata", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body).toEqual(runDetail);
    expect(RunDetailSchema.parse(res.body)).toEqual(res.body);
    expect(res.body.run.attempts[0].id).toBe(RUN_ID);
    expect(res.body.run.attempts[0].report.uuid).not.toBe(RUN_ID);
    expect(res.body.run.github_workflow.run_id).toBeNull();
    expect(res.body.run.github_workflow.event).toBeNull();
    expect(res.body.run.github_workflow.pull_request).toBeNull();
    expect(res.body.run.github_workflow).not.toHaveProperty("pull_requests");
  });

  test("names the invalid path parameter in a 400", async () => {
    const res = await get({ run_id: "invalid" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/^run_id: .*UUID/i);
    expect(res.body.code).toBe("invalid_parameters");
    expect(res.body.issues).toEqual([
      { path: ["run_id"], message: expect.stringMatching(/UUID/i) },
    ]);
    expect(getRun).not.toHaveBeenCalled();
  });

  test("returns 404 for an unknown or expired run", async () => {
    getRun.mockResolvedValue(null);
    const res = await get();
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Run not found", code: "not_found" });
    expect(ErrorResponseSchema.parse(res.body)).toEqual(res.body);
  });

  test("logs query failures and answers 500 without exposing details", async () => {
    getRun.mockRejectedValue(new Error("private database connection failed"));
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const res = await get();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: "Failed to get run",
      code: "internal_error",
    });
    expect(ErrorResponseSchema.parse(res.body)).toEqual(res.body);
    expect(consoleError).toHaveBeenCalled();
  });
});
