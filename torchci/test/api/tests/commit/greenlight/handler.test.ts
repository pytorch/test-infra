import { GET } from "app/api/tests/commit/[sha]/greenlight/route";
import type { RawQuery } from "lib/api/parameters";
import { ErrorResponseSchema } from "lib/api/schema";
import * as greenlight from "lib/api/tests/commit/greenlight/greenlight";
import type { CommitGreenlight } from "lib/api/tests/commit/greenlight/types";
import { callRoute } from "test/api/routes";

// The routes are behind the GitHub gate, which has its own tests (auth.test.ts);
// here the handlers answer as themselves.
jest.mock("lib/api/auth", () => ({
  requireGithubWriteAccess: (handler: unknown) => handler,
}));

const SHA = "573c889f49603f0bd8d0033ef6a49e3016d863d3";
const REPO = "pytorch/pytorch";

const answer: CommitGreenlight = {
  verdict: {
    status: "NO_LAND",
    reason: "not_trivial",
    message: "- Triviality\n  - Four separate perf rewrites",
    pull_request_number: 204150,
    head_sha: SHA,
    updated_at: "2026-11-10T16:46:47.169Z",
    job_url: "https://github.com/pytorch/test-infra/actions/runs/42857520608",
  },
  no_verdict_reason: null,
  hud_url: `https://hud.pytorch.org/tests/pytorch/pytorch/commit/${SHA}`,
  query_duration_ms: 12,
};

function get(query: RawQuery) {
  return callRoute(GET, "/api/tests/commit/{sha}/greenlight", query);
}

describe("app/api/tests/commit/[sha]/greenlight", () => {
  let getCommitGreenlight: jest.SpyInstance;

  beforeEach(() => {
    getCommitGreenlight = jest
      .spyOn(greenlight, "getCommitGreenlight")
      .mockResolvedValue(answer);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test.each([
    {},
    { sha: SHA },
    { repo: REPO },
    { sha: "", repo: REPO },
    { sha: "573c889", repo: REPO },
    { sha: `${SHA}0`, repo: REPO },
    { sha: SHA.replace("5", "g"), repo: REPO },
    { sha: "' OR 1 = 1 --", repo: REPO },
    { sha: SHA, repo: "pytorch" },
    { sha: SHA, repo: [REPO, "pytorch/vision"] },
    { sha: SHA, repo: REPO, pull_request_number: "204150" },
    { sha: SHA, repo: REPO, limit: "1" },
  ])(
    "rejects invalid or unsupported parameters before querying %j",
    async (query) => {
      const res = await get(query);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("invalid_parameters");
      expect(res.body.issues.length).toBeGreaterThan(0);
      expect(ErrorResponseSchema.parse(res.body)).toEqual(res.body);
      expect(getCommitGreenlight).not.toHaveBeenCalled();
    }
  );

  test("passes the repository and the lowercased SHA to the lookup", async () => {
    const res = await get({ sha: SHA.toUpperCase(), repo: REPO });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(answer);
    expect(getCommitGreenlight).toHaveBeenCalledWith({ sha: SHA, repo: REPO });
  });

  test("a commit without a verdict is a 200 with a null verdict and its reason", async () => {
    getCommitGreenlight.mockResolvedValue({
      ...answer,
      verdict: null,
      no_verdict_reason: "not_reviewed",
    });
    const res = await get({ sha: SHA, repo: REPO });
    expect(res.status).toBe(200);
    expect(res.body.verdict).toBeNull();
    expect(res.body.no_verdict_reason).toBe("not_reviewed");
  });
});
