import { NextApiRequest } from "next";
import * as clickhouseModule from "../lib/clickhouse";
import handler from "../pages/api/clickhouse/[queryName]";
import { mockRes } from "./nextApiMocks";

jest.mock("../lib/clickhouse", () => ({
  queryClickhouseSaved: jest.fn(),
}));

const mockQuery = clickhouseModule.queryClickhouseSaved as jest.Mock;

function get(parameters: string) {
  const res = mockRes();
  return handler(
    { query: { queryName: "some_query", parameters } } as any as NextApiRequest,
    res
  ).then(() => res);
}

describe("/api/clickhouse/[queryName]", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  it("returns the query result", async () => {
    mockQuery.mockResolvedValue([{ a: 1 }]);
    const res = await get('{"days": "7"}');
    expect(mockQuery).toHaveBeenCalledWith("some_query", { days: "7" });
    expect(res._status).toBe(200);
    expect(res._json).toEqual([{ a: 1 }]);
  });

  it("returns a failed query's error as JSON", async () => {
    mockQuery.mockRejectedValue(new Error("Code: 241. MEMORY_LIMIT_EXCEEDED"));
    const res = await get('{"days": "7"}');
    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: "Code: 241. MEMORY_LIMIT_EXCEEDED" });
  });

  it("rejects parameters that are not JSON", async () => {
    const res = await get("not json");
    expect(mockQuery).not.toHaveBeenCalled();
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/^Invalid parameters: /);
  });
});
