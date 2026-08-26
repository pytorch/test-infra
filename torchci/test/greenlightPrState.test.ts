import * as authModule from "lib/auth/auth";
import * as clickhouse from "lib/clickhouse";
import { NextApiRequest } from "next";
import handler from "pages/api/greenlight/pr_state";
import { mockRes } from "./nextApiMocks";

jest.mock("lib/auth/auth", () => ({
  checkAuthWithApiToken: jest.fn(),
}));

const mockCheckAuth = authModule.checkAuthWithApiToken as jest.Mock;

function mockReq(
  query: Record<string, any> = {},
  method = "GET"
): NextApiRequest {
  return {
    method,
    headers: { "x-hud-internal-bot": "valid-token" },
    query: { repo: "pytorch/pytorch", prNumbers: "123", ...query },
  } as unknown as NextApiRequest;
}

function chRow(overrides: Record<string, any> = {}) {
  return {
    pr_number: 123,
    status: "LAND",
    head_sha: "a".repeat(40),
    run_id: 32747018107,
    version: "2026-08-25T12:34:56.000Z",
    ...overrides,
  };
}

describe("GET /api/greenlight/pr_state", () => {
  let queryClickhouse: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockCheckAuth.mockResolvedValue({ ok: true, type: "header" });
    queryClickhouse = jest.spyOn(clickhouse, "queryClickhouse");
    queryClickhouse.mockResolvedValue([]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("rejects non-GET methods with 405", async () => {
    const res = mockRes();
    await handler(mockReq({}, "POST"), res);
    expect(res._status).toBe(405);
    expect(res._json.error).toBe("Method not allowed");
    expect(queryClickhouse).not.toHaveBeenCalled();
  });

  test("returns 401 when auth fails and does not query ClickHouse", async () => {
    mockCheckAuth.mockResolvedValue({ ok: false });
    const res = mockRes();
    await handler(mockReq(), res);
    expect(res._status).toBe(401);
    expect(res._json.error).toBe("Unauthorized");
    expect(queryClickhouse).not.toHaveBeenCalled();
  });

  test("returns one state per PR for a multi-PR request", async () => {
    queryClickhouse.mockResolvedValue([
      chRow({ pr_number: 1, status: "LAND", run_id: 10 }),
      chRow({ pr_number: 2, status: "NO_LAND", run_id: 20 }),
      chRow({ pr_number: 3, status: "AI_REVIEW_STARTED", run_id: 30 }),
    ]);
    const res = mockRes();
    await handler(mockReq({ prNumbers: "1,2,3" }), res);

    expect(res._status).toBe(200);
    expect(res._json.states).toHaveLength(3);
    expect(res._json.states[0]).toEqual({
      pr_number: 1,
      status: "LAND",
      head_sha: "a".repeat(40),
      run_id: 10,
      version: "2026-08-25T12:34:56.000Z",
    });
    expect(queryClickhouse.mock.calls[0][1]).toEqual({
      repo: "pytorch/pytorch",
      pr_numbers: [1, 2, 3],
    });
  });

  test("omits PRs with no ledger row rather than returning a placeholder", async () => {
    queryClickhouse.mockResolvedValue([chRow({ pr_number: 2 })]);
    const res = mockRes();
    await handler(mockReq({ prNumbers: "1,2,3" }), res);

    expect(res._status).toBe(200);
    expect(res._json.states.map((s: any) => s.pr_number)).toEqual([2]);
  });

  test("returns an empty states array when no PR has a row", async () => {
    const res = mockRes();
    await handler(mockReq({ prNumbers: "1,2" }), res);

    expect(res._status).toBe(200);
    expect(res._json).toEqual({ states: [] });
  });

  test("selects the authoritative row server-side and never filters by head_sha", async () => {
    const res = mockRes();
    await handler(mockReq(), res);

    const [query, , queryId, useQueryCache] = queryClickhouse.mock.calls[0];
    expect(query).toContain("FROM misc.greenlight_pr_state");
    expect(query).toContain("ORDER BY pr_number, run_id DESC, version DESC");
    expect(query).toContain("LIMIT 1 BY pr_number");
    expect(query).not.toContain("head_sha =");
    expect(queryId).toBe("greenlight_pr_state");
    expect(useQueryCache).toBeUndefined();
  });

  test("never selects or returns eval_hash", async () => {
    queryClickhouse.mockResolvedValue([chRow({ eval_hash: "b".repeat(64) })]);
    const res = mockRes();
    await handler(mockReq(), res);

    expect(queryClickhouse.mock.calls[0][0]).not.toContain("eval_hash");
    expect(res._status).toBe(200);
    expect(res._json.states[0]).not.toHaveProperty("eval_hash");
  });

  test("deduplicates repeated PR numbers before querying", async () => {
    const res = mockRes();
    await handler(mockReq({ prNumbers: "7,7,8" }), res);

    expect(res._status).toBe(200);
    expect(queryClickhouse.mock.calls[0][1].pr_numbers).toEqual([7, 8]);
  });

  test("tolerates whitespace around PR numbers", async () => {
    const res = mockRes();
    await handler(mockReq({ prNumbers: " 7 , 8 " }), res);

    expect(res._status).toBe(200);
    expect(queryClickhouse.mock.calls[0][1].pr_numbers).toEqual([7, 8]);
  });

  test("uses the first value when a param is repeated in the query string", async () => {
    const res = mockRes();
    await handler(
      mockReq({ repo: ["pytorch/pytorch", "other/repo"], prNumbers: ["9"] }),
      res
    );

    expect(res._status).toBe(200);
    expect(queryClickhouse.mock.calls[0][1]).toEqual({
      repo: "pytorch/pytorch",
      pr_numbers: [9],
    });
  });

  test("sets Cache-Control no-store", async () => {
    const res = mockRes();
    await handler(mockReq(), res);
    expect(res._headers["Cache-Control"]).toBe("no-store");
  });

  describe("version normalization", () => {
    async function versionOf(version: any): Promise<string> {
      queryClickhouse.mockResolvedValue([chRow({ version })]);
      const res = mockRes();
      await handler(mockReq(), res);
      expect(res._status).toBe(200);
      return res._json.states[0].version;
    }

    test("passes through a Z-suffixed ClickHouse iso value", async () => {
      expect(await versionOf("2026-08-25T18:06:28.881Z")).toBe(
        "2026-08-25T18:06:28.881Z"
      );
    });

    test("reads a zone-less value as UTC, not machine-local time", async () => {
      // Pinned to a non-UTC zone so the assertion still fails if the route ever
      // hands a zone-less ClickHouse timestamp straight to Date().
      const tz = process.env.TZ;
      process.env.TZ = "America/Los_Angeles";
      try {
        expect(await versionOf("2026-08-25 18:06:28.881")).toBe(
          "2026-08-25T18:06:28.881Z"
        );
      } finally {
        process.env.TZ = tz;
      }
    });

    test("converts an offset-suffixed value to UTC", async () => {
      expect(await versionOf("2026-08-25T20:06:28.881+02:00")).toBe(
        "2026-08-25T18:06:28.881Z"
      );
    });

    test("serializes a Date instance as ISO-8601 UTC", async () => {
      const version = new Date(Date.UTC(2026, 7, 25, 18, 6, 28, 881));
      expect(await versionOf(version)).toBe("2026-08-25T18:06:28.881Z");
    });

    test("fails closed with 500 on an unparsable version", async () => {
      queryClickhouse.mockResolvedValue([chRow({ version: "not-a-date" })]);
      const res = mockRes();
      await handler(mockReq(), res);
      expect(res._status).toBe(500);
    });
  });

  describe("input validation", () => {
    test.each<[string, Record<string, any>]>([
      ["missing repo", { repo: undefined }],
      ["empty repo", { repo: "" }],
      ["missing prNumbers", { prNumbers: undefined }],
      ["empty prNumbers", { prNumbers: "" }],
    ])("returns 400 for %s", async (_name, query) => {
      const res = mockRes();
      await handler(mockReq(query), res);
      expect(res._status).toBe(400);
      expect(res._json.error).toBe("Missing required params: repo, prNumbers");
      expect(queryClickhouse).not.toHaveBeenCalled();
    });

    test.each<[string, string]>([
      ["no slash", "pytorch"],
      ["a trailing slash", "pytorch/"],
      ["a leading slash", "/pytorch"],
      ["more than two segments", "pytorch/pytorch/extra"],
      ["whitespace", "pytorch / pytorch"],
      ["an owner longer than 100 chars", `${"a".repeat(101)}/pytorch`],
      ["a name longer than 100 chars", `pytorch/${"a".repeat(101)}`],
      ["a quote", `pytorch/pytorch" OR "1`],
      ["a trailing space", "pytorch/pytorch "],
      ["a null byte", "pytorch/pytorch\0"],
      ["a newline", "pytorch/pytorch\n"],
    ])("returns 400 for a repo with %s", async (_name, repo) => {
      const res = mockRes();
      await handler(mockReq({ repo }), res);
      expect(res._status).toBe(400);
      expect(res._json.error).toBe("repo must be owner/name");
      expect(queryClickhouse).not.toHaveBeenCalled();
    });

    test.each<[string]>([
      ["pytorch/pytorch"],
      ["pytorch/test-infra"],
      ["pytorch_labs/some.repo"],
      [`${"a".repeat(100)}/${"b".repeat(100)}`],
    ])("accepts the well-formed repo %s", async (repo) => {
      const res = mockRes();
      await handler(mockReq({ repo }), res);
      expect(res._status).toBe(200);
      expect(queryClickhouse.mock.calls[0][1].repo).toBe(repo);
    });

    test.each<[string, string]>([
      ["non-numeric", "abc"],
      ["negative", "-5"],
      ["zero", "0"],
      ["decimal", "1.5"],
      ["exponent notation", "1e3"],
      ["explicitly signed", "+5"],
      ["one bad entry among good ones", "1,abc,3"],
      ["a trailing separator", "1,2,"],
      ["beyond the safe integer range", "9007199254740993"],
    ])("returns 400 for %s prNumbers", async (_name, prNumbers) => {
      const res = mockRes();
      await handler(mockReq({ prNumbers }), res);
      expect(res._status).toBe(400);
      expect(res._json.error).toBe(
        "prNumbers must be a comma-separated list of positive integers"
      );
      expect(queryClickhouse).not.toHaveBeenCalled();
    });

    test("returns 400 when more than 50 PR numbers are requested", async () => {
      const prNumbers = Array.from({ length: 51 }, (_, i) => i + 1).join(",");
      const res = mockRes();
      await handler(mockReq({ prNumbers }), res);
      expect(res._status).toBe(400);
      expect(res._json.error).toBe("prNumbers accepts at most 50 entries");
      expect(queryClickhouse).not.toHaveBeenCalled();
    });

    test("accepts exactly 50 PR numbers", async () => {
      const prNumbers = Array.from({ length: 50 }, (_, i) => i + 1).join(",");
      const res = mockRes();
      await handler(mockReq({ prNumbers }), res);
      expect(res._status).toBe(200);
      expect(queryClickhouse.mock.calls[0][1].pr_numbers).toHaveLength(50);
    });
  });

  test("returns 500 when the ClickHouse read fails", async () => {
    queryClickhouse.mockRejectedValue(new Error("clickhouse unavailable"));
    const res = mockRes();
    await handler(mockReq(), res);
    expect(res._status).toBe(500);
    expect(res._json.error).toBe("Failed to read greenlight PR state");
  });
});
