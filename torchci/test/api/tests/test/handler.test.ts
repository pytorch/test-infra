import { GET } from "app/api/tests/test/[test_id]/route";
import type { RawQuery } from "lib/api/parameters";
import { ErrorResponseSchema } from "lib/api/schema";
import * as detail from "lib/api/tests/test/detail";
import { TestDetail, TestDetailSchema } from "lib/api/tests/test/types";
import { callRoute } from "test/api/routes";

const TEST_ID = "18446744073709551615";
const testDetail: TestDetail = {
  test: {
    id: TEST_ID,
    repo: "pytorch/pytorch",
    file: "test/test_torch.py",
    suite: "TestTorch",
    case_name: "test_add_cpu_float32",
    declared_case_name: "test_add",
    language: "python",
    first_seen_at: "2026-10-20T00:00:00Z",
  },
  owners: ["module: tests"],
  health: [],
  refreshed_at: null,
  query_duration_ms: 5,
};

function get(query: RawQuery = { test_id: TEST_ID }) {
  return callRoute(GET, "/api/tests/test/{test_id}", query);
}

describe("app/api/tests/test/[test_id]", () => {
  let getTest: jest.SpyInstance;

  beforeEach(() => {
    getTest = jest.spyOn(detail, "getTest").mockResolvedValue(testDetail);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test.each([
    {},
    { id: TEST_ID },
    { test_id: undefined },
    { test_id: "" },
    { test_id: "-1" },
    { test_id: "1.5" },
    { test_id: "1e3" },
    { test_id: " 123" },
    { test_id: "123 " },
    { test_id: "0x123" },
    { test_id: "18446744073709551616" },
    { test_id: "1' OR 1 = 1" },
    { test_id: ["123"] },
    { test_id: ["123", "456"] },
    { test_id: TEST_ID, repo: "pytorch/pytorch" },
    { test_id: TEST_ID, window: "3h" },
    { test_id: TEST_ID, ran_on: "main" },
    { test_id: TEST_ID, limit: "100" },
    { test_id: TEST_ID, cursor: "anything" },
  ])(
    "rejects invalid or unsupported parameters before querying %j",
    async (query) => {
      const res = await get(query);
      expect(res.status).toBe(400);
      expect(ErrorResponseSchema.parse(res.body)).toEqual(res.body);
      expect(getTest).not.toHaveBeenCalled();
    }
  );

  test.each([
    [TEST_ID, TEST_ID],
    ["9007199254740993", "9007199254740993"],
    ["000123", "123"],
    ["0", "0"],
  ])(
    "passes canonical ID %s without losing UInt64 precision",
    async (testId, expected) => {
      const res = await get({ test_id: testId });
      expect(res.status).toBe(200);
      expect(getTest).toHaveBeenCalledTimes(1);
      expect(getTest).toHaveBeenCalledWith(expected);
      expect(res.body).toEqual(testDetail);
    }
  );

  test("returns a known test and owners when it has no health", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(TestDetailSchema.parse(res.body)).toEqual(res.body);
    expect(res.body.test.id).toBe(TEST_ID);
    expect(res.body.owners).toEqual(["module: tests"]);
    expect(res.body.health).toEqual([]);
  });

  test("names the invalid path parameter in a 400", async () => {
    const res = await get({ test_id: "invalid" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "test_id: must be a UInt64 decimal string",
    });
    expect(getTest).not.toHaveBeenCalled();
  });

  test("returns 404 for an unknown catalog ID", async () => {
    getTest.mockResolvedValue(null);
    const res = await get();
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Test not found" });
    expect(ErrorResponseSchema.parse(res.body)).toEqual(res.body);
  });

  test("logs query failures and answers 500 without exposing details", async () => {
    getTest.mockRejectedValue(new Error("private database connection failed"));
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const res = await get();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to get test" });
    expect(ErrorResponseSchema.parse(res.body)).toEqual(res.body);
    expect(consoleError).toHaveBeenCalled();
  });
});
