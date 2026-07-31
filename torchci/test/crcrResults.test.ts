import { NextApiRequest, NextApiResponse } from "next";
import * as authModule from "../lib/auth/auth";
import * as crcrUtils from "../lib/crcr/crcrUtils";
import handler from "../pages/api/crcr/results";

jest.mock("../lib/crcr/crcrUtils", () => {
  const actual = jest.requireActual("../lib/crcr/crcrUtils");
  return {
    ...actual,
    writeToDynamo: jest.fn().mockResolvedValue(undefined),
  };
});

jest.mock("../lib/auth/auth", () => ({
  checkAuthWithApiToken: jest.fn(),
}));

const mockCheckAuth = authModule.checkAuthWithApiToken as jest.Mock;

function mockReq(overrides: Partial<NextApiRequest> = {}): NextApiRequest {
  return {
    method: "POST",
    headers: { "x-hud-internal-bot": "valid-token" },
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

describe("POST /api/crcr/results", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCheckAuth.mockResolvedValue({ ok: true, type: "header" });
  });

  test("rejects non-POST methods with 405", async () => {
    const res = mockRes();
    await handler(mockReq({ method: "GET" }), res);
    expect(res._status).toBe(405);
    expect(res._json.error).toBe("Method not allowed");
  });

  test("returns 401 when auth fails", async () => {
    mockCheckAuth.mockResolvedValue({ ok: false });
    const res = mockRes();
    await handler(mockReq(), res);
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
    expect(crcrUtils.writeToDynamo).toHaveBeenCalledTimes(1);
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
    (crcrUtils.writeToDynamo as jest.Mock).mockRejectedValueOnce(
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
