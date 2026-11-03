import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import type { NextApiRequest } from "next";
import * as authModule from "../lib/auth/auth";
import {
  extractDynamoRecord,
  extractLateReports,
  writeLateReport,
} from "../lib/crcr/crcrUtils";
import handler from "../pages/api/crcr/results";
import { mockRes } from "./nextApiMocks";

const mockUpdate = jest.fn();
const mockGet = jest.fn();
jest.mock("lib/dynamo", () => ({
  getDynamoClient: () => ({ update: mockUpdate, get: mockGet }),
}));

jest.mock("../lib/auth/auth", () => ({
  checkAuthWithApiToken: jest.fn(),
}));
const mockCheckAuth = authModule.checkAuthWithApiToken as jest.Mock;

const VERDICT = {
  schema_version: 1,
  category: "upstream",
  confidence: "high",
  summary: "aten::foo lost its out= overload.",
  evidence: [
    {
      job: "Distributed Tests (4 GPUs)",
      log_url: "https://buildkite.com/vllm/ci/builds/91827#0194a4f1-aaaa",
      excerpt: "RuntimeError: no matching overload for foo.out",
    },
  ],
};

// One report as the relay forwards it: a Buildkite nightly row, so no check run id.
function entry(overrides: Record<string, unknown> = {}) {
  return {
    delivery_id: "buildkite-91827-0194a4f1-aaaa",
    workflow_name: "ci",
    job_name: "Distributed Tests (4 GPUs)",
    triage_verdict: VERDICT,
    ...overrides,
  };
}

function lateReport(reports: unknown[] = [entry()], trusted: any = {}) {
  return {
    trusted: {
      verified_repo: "vllm-project/vllm",
      downstream_repo_level: "L2",
      ...trusted,
    },
    untrusted: {
      callback_payload: { event_type: "late-report", reports },
    },
  };
}

// The same row's original callback.
function callback(
  eventType: string,
  repo: string,
  deliveryId: string,
  workflow: Record<string, unknown>
) {
  return {
    trusted: { verified_repo: repo },
    untrusted: {
      callback_payload: {
        event_type: eventType,
        delivery_id: deliveryId,
        payload: {
          pull_request: { number: 7, head: { sha: "abc123" } },
          repository: { full_name: "pytorch/pytorch" },
        },
        workflow: {
          status: "completed",
          conclusion: "failure",
          url: "https://example.com/run/1",
          ...workflow,
        },
      },
    },
  };
}

function conditionFailed() {
  return new ConditionalCheckFailedException({
    message: "The conditional request failed",
    $metadata: {},
  });
}

describe("extractLateReports", () => {
  test("keys each row exactly as its original callback did", () => {
    const buildkite = extractDynamoRecord(
      callback(
        "nightly",
        "vllm-project/vllm",
        "buildkite-91827-0194a4f1-aaaa",
        { name: "ci", job_name: "Distributed Tests (4 GPUs)" }
      ) as any
    );
    const github = extractDynamoRecord(
      callback("pull_request", "acme/backend", "d-1", {
        name: "ci",
        job_name: "build",
        check_run_id: "9001",
      }) as any
    );
    const keys = [
      ...extractLateReports(lateReport()),
      ...extractLateReports(
        lateReport(
          [
            entry({
              delivery_id: "d-1",
              job_name: "build",
              check_run_id: 9001,
            }),
          ],
          { verified_repo: "acme/backend" }
        )
      ),
    ].map((r) => r.dynamoKey);
    expect(keys).toEqual([buildkite.dynamoKey, github.dynamoKey]);
  });

  test("rejects the whole request, naming the bad report", () => {
    expect(() =>
      extractLateReports(lateReport([entry(), entry({ job_name: undefined })]))
    ).toThrow("reports[1].job_name");
    expect(() => extractLateReports(lateReport([]))).toThrow("non-empty");
  });
});

describe("writeLateReport", () => {
  const [report] = extractLateReports(lateReport());

  beforeEach(() => {
    mockUpdate.mockReset();
    mockGet.mockReset();
  });

  test("sets only the verdict, on an existing finished row that has none", async () => {
    mockUpdate.mockResolvedValueOnce({});
    await expect(writeLateReport(report)).resolves.toBe("attached");

    const args = mockUpdate.mock.calls[0][0];
    expect(args.Key).toEqual({ dynamoKey: report.dynamoKey });
    expect(args.UpdateExpression).toBe("SET #verdict = :verdict");
    // Without attribute_exists an UpdateItem would create the row.
    expect(args.ConditionExpression).toBe(
      "attribute_exists(dynamoKey) AND #status = :completed AND " +
        "attribute_not_exists(#verdict)"
    );
  });

  test.each([
    ["the job was never reported", undefined, "no_such_row"],
    ["the row is not finalized", { status: "in_progress" }, "not_finalized"],
    [
      "the row already has a verdict",
      { status: "completed", triage_verdict_json: "{}" },
      "already_has_verdict",
    ],
  ])("says so when %s", async (_label, item, outcome) => {
    mockUpdate.mockRejectedValueOnce(conditionFailed());
    mockGet.mockResolvedValueOnce({ Item: item });
    await expect(writeLateReport(report)).resolves.toBe(outcome);
  });
});

describe("POST /api/crcr/results with a late-report callback", () => {
  function req(body: unknown): NextApiRequest {
    return {
      method: "POST",
      headers: { "x-hud-internal-bot": "valid-token" },
      body,
    } as unknown as NextApiRequest;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdate.mockReset();
    mockGet.mockReset();
    mockCheckAuth.mockResolvedValue({ ok: true, type: "header" });
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  test("adds each verdict and says what happened to each report", async () => {
    mockUpdate
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(conditionFailed())
      .mockRejectedValueOnce(new Error("throttled"));
    mockGet.mockResolvedValueOnce({}); // the second has no row
    const res = mockRes();
    await handler(
      req(
        lateReport([
          entry({ job_name: "A", delivery_id: "d-a" }),
          entry({ job_name: "B", delivery_id: "d-b" }),
          entry({ job_name: "C", delivery_id: "d-c" }),
        ])
      ),
      res
    );

    expect(res._status).toBe(200);
    expect(res._json.results.map((r: any) => [r.job_name, r.result])).toEqual([
      ["A", "attached"],
      ["B", "no_such_row"],
      ["C", "error"],
    ]);
  });

  test("rejects a bad request with 400 before writing anything", async () => {
    const res = mockRes();
    await handler(
      req(lateReport([entry(), entry({ triage_verdict: undefined })])),
      res
    );
    expect(res._status).toBe(400);
    expect(res._json.error).toContain("reports[1].triage_verdict");
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test("an ordinary callback still takes the write-once path", async () => {
    mockUpdate.mockResolvedValueOnce({});
    const res = mockRes();
    await handler(
      req(
        callback("nightly", "vllm-project/vllm", "buildkite-1-abc", {
          name: "ci",
          job_name: "Kernels",
          triage_verdict: VERDICT,
        })
      ),
      res
    );

    expect(res._status).toBe(200);
    expect(res._json.status).toBe("completed");
    expect(mockUpdate.mock.calls[0][0].ConditionExpression).toContain(
      "#guard_status"
    );
  });
});
