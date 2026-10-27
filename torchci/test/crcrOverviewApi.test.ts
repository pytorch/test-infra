import { NextApiRequest } from "next";
import * as clickhouseModule from "../lib/clickhouse";
import handler from "../pages/api/crcr/overview";
import { mockRes } from "./nextApiMocks";

jest.mock("../lib/clickhouse", () => ({
  queryClickhouseSaved: jest.fn(),
}));

const mockQuery = clickhouseModule.queryClickhouseSaved as jest.Mock;

function get(query: Record<string, string> = { days: "7" }) {
  const res = mockRes();
  return handler({ method: "GET", query } as NextApiRequest, res).then(
    () => res
  );
}

describe("/api/crcr/overview", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("runs the fixed overview query plan serially", async () => {
    let activeQueries = 0;
    let maxActiveQueries = 0;
    mockQuery.mockImplementation(async () => {
      activeQueries += 1;
      maxActiveQueries = Math.max(maxActiveQueries, activeQueries);
      await Promise.resolve();
      activeQueries -= 1;
      return [];
    });

    const res = await get();

    expect(res._status).toBe(200);
    expect(maxActiveQueries).toBe(1);
    expect(mockQuery.mock.calls.map(([queryName]) => queryName)).toEqual([
      "crcr_summary",
      "crcr_nightly_summary",
      "crcr_health_last_prs",
      "crcr_nightly_dashboard",
      "crcr_l3_summary",
      "crcr_l3_summary",
      "crcr_repo_tenure_summary",
    ]);
    expect(mockQuery).toHaveBeenNthCalledWith(
      1,
      "crcr_summary",
      { days: 7 },
      true
    );
    expect(mockQuery).toHaveBeenNthCalledWith(
      7,
      "crcr_repo_tenure_summary",
      {},
      true
    );
    expect(res._json.errors).toEqual({});
    expect(res._headers["Cache-Control"]).toBe(
      "s-maxage=30, stale-while-revalidate=60"
    );
  });

  it("returns partial data when one section is unavailable", async () => {
    mockQuery.mockImplementation(async (queryName: string) => {
      if (queryName === "crcr_nightly_summary") {
        throw new Error("nightly unavailable");
      }
      return [{ queryName }];
    });

    const res = await get();

    expect(res._status).toBe(200);
    expect(res._json.errors).toEqual({
      nightlySummary: "nightly unavailable",
    });
    expect(res._json.data.prSummary).toEqual([{ queryName: "crcr_summary" }]);
    expect(res._json.data.nightlySummary).toEqual([]);
    expect(res._json.data.demotionReadiness).toEqual([
      { queryName: "crcr_l3_summary" },
    ]);
    expect(res._json.data.tenure).toEqual([
      { queryName: "crcr_repo_tenure_summary" },
    ]);
    expect(mockQuery).toHaveBeenCalledTimes(7);
    expect(res._headers["Cache-Control"]).toBe("no-store");
  });

  it("rejects an unsupported time range before querying ClickHouse", async () => {
    const res = await get({ days: "2" });

    expect(res._status).toBe(400);
    expect(res._json).toEqual({ error: "Invalid CRCR time range" });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("only accepts GET", async () => {
    const res = mockRes();

    await handler({ method: "POST", query: {} } as NextApiRequest, res);

    expect(res._status).toBe(405);
  });
});
