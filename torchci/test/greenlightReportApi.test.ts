// POST /api/greenlight/report. The handler's job is narrow and the tests follow
// it: refuse anyone outside the HUD GitHub gate, read the verdict back from
// ClickHouse instead of believing the request, file one issue, and survive the
// board add failing.

import * as githubAuth from "lib/auth/githubAuth";
import * as clickhouse from "lib/clickhouse";
import * as github from "lib/github";
import {
  GREENLIGHT_REPORT_LABEL,
  GREENLIGHT_REPORT_PROJECT_ID,
} from "lib/greenlight/greenlightReport";
import { NextApiRequest } from "next";
import handler from "pages/api/greenlight/report";
import { mockRes } from "./nextApiMocks";

jest.mock("lib/auth/githubAuth", () => ({
  resolveGithubToken: jest.fn(),
  authorizeGithubToken: jest.fn(),
}));
jest.mock("lib/clickhouse", () => ({
  queryClickhouseSaved: jest.fn(),
}));
jest.mock("lib/github", () => ({
  getOctokit: jest.fn(),
}));

const mockResolveToken = githubAuth.resolveGithubToken as jest.Mock;
const mockAuthorize = githubAuth.authorizeGithubToken as jest.Mock;
const mockQuery = clickhouse.queryClickhouseSaved as jest.Mock;
const mockGetOctokit = github.getOctokit as jest.Mock;

const HEAD_SHA = "a".repeat(40);

function mockReq(body: any = {}, method = "POST"): NextApiRequest {
  return {
    method,
    headers: {},
    query: {},
    body: {
      repoOwner: "pytorch",
      repoName: "pytorch",
      prNumber: 1234,
      sha: HEAD_SHA,
      comment: "Should have been approved.",
      ...body,
    },
  } as unknown as NextApiRequest;
}

function chRow(overrides: Record<string, any> = {}) {
  return {
    pr_number: 1234,
    head_sha: HEAD_SHA,
    merge_commit_sha: "",
    status: "NO_LAND",
    reason: "touches_release_config",
    message: "The diff edits a release workflow.",
    eval_job: "https://github.com/pytorch/test-infra/actions/runs/1",
    run_id: 7,
    version: "2026-09-15T10:00:00.000Z",
    ...overrides,
  };
}

let createIssue: jest.Mock;
let graphql: jest.Mock;

function octokit() {
  return {
    rest: { issues: { create: createIssue } },
    graphql,
  };
}

describe("POST /api/greenlight/report", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "error").mockImplementation(() => {});
    mockResolveToken.mockResolvedValue("gho_token");
    mockAuthorize.mockResolvedValue({ ok: true, login: "octocat" });
    mockQuery.mockResolvedValue([chRow()]);
    createIssue = jest.fn().mockResolvedValue({
      data: {
        number: 42,
        node_id: "I_kwDO",
        html_url: "https://github.com/pytorch/test-infra/issues/42",
      },
    });
    graphql = jest.fn().mockResolvedValue({});
    mockGetOctokit.mockResolvedValue(octokit());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("rejects non-POST methods with 405", async () => {
    const res = mockRes();
    await handler(mockReq({}, "GET"), res);
    expect(res._status).toBe(405);
    expect(createIssue).not.toHaveBeenCalled();
  });

  test("returns 401 when there is no token", async () => {
    mockResolveToken.mockResolvedValue(null);
    const res = mockRes();
    await handler(mockReq(), res);
    expect(res._status).toBe(401);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(createIssue).not.toHaveBeenCalled();
  });

  test("passes the gate's own status through and files nothing", async () => {
    mockAuthorize.mockResolvedValue({
      ok: false,
      status: 403,
      error: "Write permissions to pytorch/pytorch repository required",
    });
    const res = mockRes();
    await handler(mockReq(), res);
    expect(res._status).toBe(403);
    expect(res._json.error).toContain("Write permissions");
    expect(createIssue).not.toHaveBeenCalled();
  });

  test("returns 400 on an invalid body without touching ClickHouse", async () => {
    const res = mockRes();
    await handler(mockReq({ comment: "  " }), res);
    expect(res._status).toBe(400);
    expect(res._json.error).toBe("comment is required");
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("returns 404 when no verdict matches the commit", async () => {
    mockQuery.mockResolvedValue([chRow({ head_sha: "b".repeat(40) })]);
    const res = mockRes();
    await handler(mockReq(), res);
    expect(res._status).toBe(404);
    expect(createIssue).not.toHaveBeenCalled();
  });

  test("refuses a status that is not a judgement", async () => {
    for (const status of [
      "CANCELLED",
      "FAILED",
      "REVERTED",
      "AI_REVIEW_STARTED",
    ]) {
      mockQuery.mockResolvedValue([chRow({ status })]);
      const res = mockRes();
      await handler(mockReq(), res);
      expect(res._status).toBe(400);
      expect(res._json.error).toContain("LAND and NO_LAND");
    }
    expect(createIssue).not.toHaveBeenCalled();
  });

  test("returns 500 when the state lookup throws", async () => {
    mockQuery.mockRejectedValue(new Error("clickhouse down"));
    const res = mockRes();
    await handler(mockReq(), res);
    expect(res._status).toBe(500);
    expect(createIssue).not.toHaveBeenCalled();
  });

  test("files one labelled issue on test-infra and adds it to the board", async () => {
    const res = mockRes();
    await handler(mockReq(), res);

    expect(mockQuery).toHaveBeenCalledWith("greenlight_pr_state_history", {
      repo: "pytorch/pytorch",
      owner: "pytorch",
      project: "pytorch",
      prNumber: 1234,
    });
    expect(createIssue).toHaveBeenCalledTimes(1);
    const issue = createIssue.mock.calls[0][0];
    expect(issue.owner).toBe("pytorch");
    expect(issue.repo).toBe("test-infra");
    expect(issue.labels).toEqual([GREENLIGHT_REPORT_LABEL]);
    expect(issue.title).toBe(
      "[GreenLight policy] Wrong NO_LAND verdict on pytorch/pytorch#1234 (aaaaaaa)"
    );

    expect(graphql).toHaveBeenCalledTimes(1);
    expect(graphql.mock.calls[0][1]).toEqual({
      projectId: GREENLIGHT_REPORT_PROJECT_ID,
      contentId: "I_kwDO",
    });

    expect(res._status).toBe(201);
    expect(res._json).toEqual({
      issueUrl: "https://github.com/pytorch/test-infra/issues/42",
      issueNumber: 42,
      addedToProject: true,
    });
  });

  test("credits the authenticated login, not one the client supplies", async () => {
    const res = mockRes();
    await handler(mockReq({ reporter: "mallory", login: "mallory" }), res);
    const body = createIssue.mock.calls[0][0].body;
    expect(body).toContain("Reported by @octocat");
    expect(body).not.toContain("mallory");
    expect(res._status).toBe(201);
  });

  test("publishes the stored verdict, not one the client asserts", async () => {
    const res = mockRes();
    await handler(
      mockReq({ status: "LAND", reason: "clean", message: "looks fine" }),
      res
    );
    const { title, body } = createIssue.mock.calls[0][0];
    expect(title).toContain("Wrong NO_LAND verdict");
    expect(body).toContain("- **Verdict:** `NO_LAND`");
    expect(body).toContain("- **Reason:** `touches_release_config`");
    expect(body).not.toContain("looks fine");
  });

  test("names the reviewed commit when the report arrives by trunk sha", async () => {
    const trunkSha = "c".repeat(40);
    mockQuery.mockResolvedValue([chRow({ merge_commit_sha: trunkSha })]);
    const res = mockRes();
    await handler(mockReq({ sha: trunkSha }), res);
    expect(res._status).toBe(201);
    const { title, body } = createIssue.mock.calls[0][0];
    expect(title).toContain("(aaaaaaa)");
    expect(body).toContain(
      `- **Reviewed commit:** pytorch/pytorch@${HEAD_SHA}`
    );
    expect(body).toContain(
      `- **Landed on trunk as:** pytorch/pytorch@${trunkSha}`
    );
  });

  test("keeps the issue when the board add fails", async () => {
    graphql.mockRejectedValue(
      new Error("Resource not accessible by integration")
    );
    const res = mockRes();
    await handler(mockReq(), res);
    expect(res._status).toBe(201);
    expect(res._json.issueNumber).toBe(42);
    expect(res._json.addedToProject).toBe(false);
  });

  test("returns 502 when the issue itself cannot be filed", async () => {
    createIssue.mockRejectedValue(new Error("422"));
    const res = mockRes();
    await handler(mockReq(), res);
    expect(res._status).toBe(502);
    expect(graphql).not.toHaveBeenCalled();
  });
});
