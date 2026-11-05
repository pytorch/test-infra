import { GET } from "app/api/tests/pull/[number]/route";
import type { RawQuery } from "lib/api/parameters";
import { ErrorResponseSchema } from "lib/api/schema";
import * as head from "lib/api/tests/pull/head";
import type { PullRequestHead } from "lib/api/tests/pull/types";
import { callRoute } from "test/api/routes";

// The routes are behind the GitHub gate, which has its own tests (auth.test.ts);
// here the handlers answer as themselves.
jest.mock("lib/api/auth", () => ({
  requireGithubWriteAccess: (handler: unknown) => handler,
}));

const pullRequest: PullRequestHead = {
  number: 203277,
  title: "[BE][Test] Trim mode OpInfo sample inputs",
  url: "https://github.com/pytorch/pytorch/pull/203277",
  head_sha: "b2bbfce524a163c99bb1ad47909387679100688d",
  hud_url: "https://hud.pytorch.org/tests/pytorch/pytorch/pull/203277",
  query_duration_ms: 5,
};

function get(query: RawQuery) {
  return callRoute(GET, "/api/tests/pull/{number}", query);
}

describe("app/api/tests/pull/[number]", () => {
  let getPullRequestHead: jest.SpyInstance;

  beforeEach(() => {
    getPullRequestHead = jest
      .spyOn(head, "getPullRequestHead")
      .mockResolvedValue(pullRequest);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test.each([
    {},
    { number: "203277" },
    { repo: "pytorch/pytorch" },
    { number: "", repo: "pytorch/pytorch" },
    { number: "0", repo: "pytorch/pytorch" },
    { number: "-1", repo: "pytorch/pytorch" },
    { number: "0203277", repo: "pytorch/pytorch" },
    { number: "2032.77", repo: "pytorch/pytorch" },
    { number: "1e5", repo: "pytorch/pytorch" },
    { number: "#203277", repo: "pytorch/pytorch" },
    { number: " 203277", repo: "pytorch/pytorch" },
    { number: "12345678901", repo: "pytorch/pytorch" },
    { number: "' OR 1 = 1 --", repo: "pytorch/pytorch" },
    { number: "203277", repo: "pytorch" },
    { number: "203277", repo: ["pytorch/pytorch", "pytorch/vision"] },
    { number: "203277", repo: "pytorch/pytorch", sha: "abc" },
    { number: "203277", repo: "pytorch/pytorch", limit: "1" },
  ])(
    "rejects invalid or unsupported parameters before querying %j",
    async (query) => {
      const res = await get(query);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("invalid_parameters");
      expect(res.body.issues.length).toBeGreaterThan(0);
      expect(ErrorResponseSchema.parse(res.body)).toEqual(res.body);
      expect(getPullRequestHead).not.toHaveBeenCalled();
    }
  );

  test.each([
    ["1", 1],
    ["203277", 203277],
    ["9999999999", 9999999999],
  ])(
    "accepts number %s and passes it to the lookup as a number",
    async (number, parsed) => {
      const res = await get({ number, repo: "pytorch/pytorch" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual(pullRequest);
      expect(getPullRequestHead).toHaveBeenCalledWith({
        number: parsed,
        repo: "pytorch/pytorch",
      });
    }
  );

  test("a pull request the lookup does not find is a 404", async () => {
    getPullRequestHead.mockResolvedValue(null);
    const res = await get({ number: "203277", repo: "pytorch/pytorch" });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: "Pull request not found",
      code: "not_found",
    });
  });
});
