import * as lambda from "lib/lambda";
import type { NextApiRequest, NextApiResponse } from "next";
import handler from "pages/api/log-uploader/backfill";

function mockRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as NextApiResponse & {
    status: jest.Mock;
    json: jest.Mock;
  };
}

function mockReq(overrides: Partial<NextApiRequest> = {}): NextApiRequest {
  return {
    method: "POST",
    headers: { authorization: "secret" },
    body: { repo: "pytorch/executorch", job_id: 999, conclusion: "failure" },
    ...overrides,
  } as NextApiRequest;
}

describe("/api/log-uploader/backfill", () => {
  let invoke: jest.SpyInstance;

  beforeEach(() => {
    invoke = jest.spyOn(lambda, "invokeLogUploader").mockResolvedValue();
    process.env.LOG_UPLOADER_BOT_KEY = "secret";
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.LOG_UPLOADER_BOT_KEY;
  });

  test("queues an upload for an authorized request", async () => {
    const res = mockRes();
    await handler(mockReq(), res);

    expect(invoke).toHaveBeenCalledWith({
      repo: "pytorch/executorch",
      job_id: 999,
      conclusion: "failure",
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test("accepts a job_id that arrived as a string", async () => {
    const res = mockRes();
    await handler(
      mockReq({ body: { repo: "pytorch/pytorch", job_id: "42" } }),
      res
    );

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({ job_id: 42 })
    );
  });

  test("rejects a request with no credentials", async () => {
    const res = mockRes();
    await handler(mockReq({ headers: {} }), res);

    expect(invoke).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test("rejects a request with the wrong credentials", async () => {
    const res = mockRes();
    await handler(mockReq({ headers: { authorization: "guess" } }), res);

    expect(invoke).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test("an unset key does not become an open endpoint", async () => {
    // Otherwise a missing env var would silently reproduce the unauthenticated
    // API Gateway endpoint this route exists to replace.
    delete process.env.LOG_UPLOADER_BOT_KEY;
    const res = mockRes();
    await handler(mockReq({ headers: {} }), res);

    expect(invoke).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test("rejects anything but POST", async () => {
    const res = mockRes();
    await handler(mockReq({ method: "GET" }), res);

    expect(invoke).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(405);
  });

  test.each([
    ["a missing repo", { job_id: 1 }],
    ["a repo with no owner", { repo: "pytorch", job_id: 1 }],
    ["a missing job_id", { repo: "pytorch/pytorch" }],
    ["a non-numeric job_id", { repo: "pytorch/pytorch", job_id: "abc" }],
    ["a negative job_id", { repo: "pytorch/pytorch", job_id: -1 }],
  ])("rejects %s", async (_label, body) => {
    const res = mockRes();
    await handler(mockReq({ body }), res);

    expect(invoke).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test("an empty body does not throw", async () => {
    const res = mockRes();
    await handler(mockReq({ body: undefined }), res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  test.each([
    ["credentials are missing", new lambda.MissingAwsCredentialsError()],
    ["the role cannot invoke", new Error("AccessDeniedException")],
    ["the Lambda API is unreachable", new Error("TimeoutError")],
  ])("reports 502 rather than throwing when %s", async (_label, error) => {
    invoke.mockRejectedValue(error);
    jest.spyOn(console, "error").mockImplementation(() => {});
    const res = mockRes();
    await handler(mockReq(), res);

    expect(res.status).toHaveBeenCalledWith(502);
  });
});
