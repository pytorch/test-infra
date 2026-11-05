import { GET } from "app/api/tests/cost/route";
import type { RawQuery } from "lib/api/parameters";
import { ErrorResponseSchema } from "lib/api/schema";
import * as runnerHours from "lib/api/tests/cost/runnerHours";
import { RunnerHoursSchema } from "lib/api/tests/cost/types";
import { callRoute } from "test/api/routes";
import ANSWER_JSON from "test/tests/cost/answer.json";

// The routes are behind the GitHub gate, which has its own tests (auth.test.ts);
// here the handlers answer as themselves.
jest.mock("lib/api/auth", () => ({
  requireGithubWriteAccess: (handler: unknown) => handler,
}));

// The example answer beside the cost page's tests.
const ANSWER = RunnerHoursSchema.parse(ANSWER_JSON);

function get(query: RawQuery = { repo: "pytorch/pytorch" }) {
  return callRoute(GET, "/api/tests/cost", query);
}

describe("app/api/tests/cost", () => {
  let getRunnerHours: jest.SpyInstance;

  beforeEach(() => {
    getRunnerHours = jest
      .spyOn(runnerHours, "getRunnerHours")
      .mockResolvedValue(ANSWER);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test.each([
    {},
    { repo: "" },
    { repo: "pytorch" },
    { repo: "pytorch/pytorch/extra" },
    { repo: "' OR 1 = 1 --" },
    { repo: ["pytorch/pytorch", "pytorch/vision"] },
    { repo: "pytorch/pytorch", window: "14d" },
    { repo: "pytorch/pytorch", window: "7" },
    { repo: "pytorch/pytorch", window: "" },
    { repo: "pytorch/pytorch", window: ["1d", "3d"] },
    { window: "7d" },
    // The page's choices are summed in the browser, never asked of the API.
    { repo: "pytorch/pytorch", workflow: "pull" },
    { repo: "pytorch/pytorch", owner: "inductor" },
    { repo: "pytorch/pytorch", machine: "NVIDIA L4" },
    // Nor are rates: the API holds no prices.
    { repo: "pytorch/pytorch", rates: "{}" },
  ])(
    "rejects invalid or unsupported parameters before querying %j",
    async (query) => {
      const res = await get(query);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("invalid_parameters");
      expect(res.body.issues.length).toBeGreaterThan(0);
      expect(ErrorResponseSchema.parse(res.body)).toEqual(res.body);
      expect(getRunnerHours).not.toHaveBeenCalled();
    }
  );

  test.each(["1d", "3d", "7d"])(
    "passes window %s to the runner-hours",
    async (window) => {
      const res = await get({ repo: "pytorch/pytorch", window });
      expect(res.status).toBe(200);
      expect(getRunnerHours).toHaveBeenCalledWith({
        repo: "pytorch/pytorch",
        window,
      });
    }
  );

  test("answers the runner-hours of the last 7 days by default, cached privately for ten minutes", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(getRunnerHours).toHaveBeenCalledWith({
      repo: "pytorch/pytorch",
      window: "7d",
    });
    expect(res.body).toEqual(ANSWER);
    expect(RunnerHoursSchema.parse(res.body)).toEqual(res.body);
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=600");
    expect(res.headers.get("Vary")).toBe("Authorization, Cookie");
  });

  test("names the invalid parameter in a 400", async () => {
    const res = await get({ repo: "pytorch/pytorch", window: "14d" });
    expect(res.status).toBe(400);
    expect(res.body.issues).toEqual([
      { path: ["window"], message: "window must be one of: 1d, 3d, 7d" },
    ]);
  });

  test("logs query failures and answers 500 without exposing details", async () => {
    getRunnerHours.mockRejectedValue(
      new Error("private database connection failed")
    );
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const res = await get();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: "Failed to compute the runner-hours",
      code: "internal_error",
    });
    expect(ErrorResponseSchema.parse(res.body)).toEqual(res.body);
    expect(consoleError).toHaveBeenCalled();
  });
});
