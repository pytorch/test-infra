import { NextApiRequest, NextApiResponse } from "next";
import * as ootUtils from "../lib/oot/ootUtils";
import handler from "../pages/api/oot/results";

jest.mock("../lib/oot/ootUtils", () => {
  const actual = jest.requireActual("../lib/oot/ootUtils");
  return {
    ...actual,
    writeToDynamo: jest.fn().mockResolvedValue(undefined),
  };
});

const VALID_TOKEN = "test-relay-token-abc123";

function mockReq(overrides: Partial<NextApiRequest> = {}): NextApiRequest {
  return {
    method: "POST",
    headers: { "x-oot-relay-token": VALID_TOKEN },
    body: {
      trusted: {
        verified_repo: "Ascend/pytorch",
        downstream_repo_level: "L2",
        ci_metrics: { queue_time: 5.0, execution_time: null },
      },
      untrusted: {
        callback_payload: {
          event_type: "workflow_job",
          delivery_id: "del-001",
          payload: {
            pull_request: { number: 100, head: { sha: "abc123" } },
            repository: { full_name: "pytorch/pytorch" },
          },
          workflow: {
            status: "in_progress",
            name: "npu-ci",
            url: "https://github.com/Ascend/pytorch/actions/runs/1",
            job_name: "build",
            check_run_id: "9001",
            run_id: "555",
            run_attempt: 1,
            started_at: "2026-05-20T10:00:00Z",
          },
        },
      },
    },
    ...overrides,
  } as unknown as NextApiRequest;
}

function mockRes(): NextApiResponse & { _status: number; _json: any } {
  const res: any = {
    _status: 0,
    _json: null,
    status(code: number) {
      res._status = code;
      return res;
    },
    json(data: any) {
      res._json = data;
      return res;
    },
  };
  return res;
}

describe("POST /api/oot/results", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, OOT_RELAY_TOKEN: VALID_TOKEN };
    jest.clearAllMocks();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test("rejects non-POST methods with 405", async () => {
    const res = mockRes();
    await handler(mockReq({ method: "GET" }), res);
    expect(res._status).toBe(405);
    expect(res._json.error).toBe("Method not allowed");
  });

  test("returns 500 when OOT_RELAY_TOKEN env is not set", async () => {
    delete process.env.OOT_RELAY_TOKEN;
    const res = mockRes();
    await handler(mockReq(), res);
    expect(res._status).toBe(500);
    expect(res._json.error).toBe("Server misconfigured");
  });

  test("returns 401 when token header is missing", async () => {
    const res = mockRes();
    await handler(mockReq({ headers: {} }), res);
    expect(res._status).toBe(401);
    expect(res._json.error).toBe("Unauthorized");
  });

  test("returns 401 when token header is wrong", async () => {
    const res = mockRes();
    await handler(
      mockReq({ headers: { "x-oot-relay-token": "wrong-token" } }),
      res
    );
    expect(res._status).toBe(401);
    expect(res._json.error).toBe("Unauthorized");
  });

  test("returns 401 when token has different length", async () => {
    const res = mockRes();
    await handler(mockReq({ headers: { "x-oot-relay-token": "short" } }), res);
    expect(res._status).toBe(401);
    expect(res._json.error).toBe("Unauthorized");
  });

  test("returns 200 and writes to DynamoDB on valid request", async () => {
    const res = mockRes();
    await handler(mockReq(), res);
    expect(res._status).toBe(200);
    expect(res._json.ok).toBe(true);
    expect(res._json.status).toBe("in_progress");
    expect(res._json.dynamoKey).toContain("Ascend/pytorch");
    expect(ootUtils.writeToDynamo).toHaveBeenCalledTimes(1);
  });

  test("returns 400 when required fields are missing", async () => {
    const body = {
      trusted: { verified_repo: "test/repo" },
      untrusted: {
        callback_payload: {
          event_type: "workflow_job",
          delivery_id: "del-002",
          payload: {},
          workflow: {
            status: "in_progress",
            name: "ci",
            url: "https://example.com",
            // job_name intentionally missing
          },
        },
      },
    };
    const res = mockRes();
    await handler(mockReq({ body }), res);
    expect(res._status).toBe(400);
    expect(res._json.error).toContain("job_name");
  });

  test("returns 500 when DynamoDB write fails", async () => {
    (ootUtils.writeToDynamo as jest.Mock).mockRejectedValueOnce(
      new Error("DynamoDB connection failed")
    );
    const res = mockRes();
    await handler(mockReq(), res);
    expect(res._status).toBe(500);
    expect(res._json.error).toContain("Internal error");
  });

  test("handles string body by parsing JSON", async () => {
    const body = JSON.stringify(mockReq().body);
    const res = mockRes();
    await handler(mockReq({ body }), res);
    expect(res._status).toBe(200);
    expect(res._json.ok).toBe(true);
  });
});
