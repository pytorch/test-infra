import { NextApiRequest } from "next";
import * as clickhouseModule from "../lib/clickhouse";
import { fetcherHandleError } from "../lib/GeneralUtils";
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

describe("fetcherHandleError", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  function respond(status: number, body: string) {
    global.fetch = jest.fn().mockResolvedValue({
      ok: status < 400,
      status,
      text: () => Promise.resolve(body),
      json: () => Promise.resolve(JSON.parse(body)),
    }) as any;
  }

  it("puts the server's error in the message", async () => {
    respond(500, JSON.stringify({ error: "MEMORY_LIMIT_EXCEEDED" }));
    await expect(fetcherHandleError("/api/clickhouse/q")).rejects.toMatchObject(
      {
        message:
          "An error occurred while fetching the data: MEMORY_LIMIT_EXCEEDED",
        status: 500,
        info: "MEMORY_LIMIT_EXCEEDED",
      }
    );
  });

  it("handles a body that is not JSON", async () => {
    respond(500, "Internal Server Error");
    await expect(fetcherHandleError("/api/clickhouse/q")).rejects.toMatchObject(
      {
        message:
          "An error occurred while fetching the data: Internal Server Error",
        status: 500,
      }
    );
  });
});
