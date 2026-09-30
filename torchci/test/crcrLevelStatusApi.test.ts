import { NextApiRequest } from "next";
import * as clickhouseModule from "../lib/clickhouse";
import { L3SummaryRow } from "../lib/crcr/l3Readiness";
import * as allowlistModule from "../lib/crcrAllowlist";
import { CrcrAllowlist } from "../lib/crcrAllowlist";
import handler from "../pages/api/crcr/level-status";
import { mockRes } from "./nextApiMocks";

jest.mock("../lib/clickhouse", () => ({
  queryClickhouseSaved: jest.fn(),
}));

jest.mock("../lib/github", () => ({
  getOctokit: jest.fn().mockResolvedValue({}),
}));

jest.mock("../lib/crcrAllowlist", () => {
  const actual = jest.requireActual("../lib/crcrAllowlist");
  return { ...actual, fetchCrcrAllowlist: jest.fn() };
});

const mockQuery = clickhouseModule.queryClickhouseSaved as jest.Mock;
const mockFetchAllowlist = allowlistModule.fetchCrcrAllowlist as jest.Mock;

const ALLOWLIST = CrcrAllowlist.fromYaml(`
L2:
  - vendor/l2
L3:
  crcr-test:
    pytorch/crcr-test: [a]
  npu:
    vendor/healthy: [b]
    vendor/failing: [c]
    vendor/silent: [d]
`);

function summary(overrides: Partial<L3SummaryRow>): L3SummaryRow {
  return {
    repo: "vendor/healthy",
    successes: 100,
    timed_out: 0,
    total_jobs: 100,
    pass_rate: 1.0,
    avg_queue_time_s: 60,
    max_exec_time_s: 3600,
    overrun_rate: 0,
    median_e2e_time_s: 3600,
    timeout_rate: 0,
    ...overrides,
  };
}

function get(method = "GET") {
  const res = mockRes();
  return handler({ method } as NextApiRequest, res).then(() => res);
}

describe("/api/crcr/level-status", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchAllowlist.mockResolvedValue(ALLOWLIST);
  });

  it("returns the demotion verdict of every L3 repo", async () => {
    mockQuery.mockResolvedValue([
      summary({ repo: "vendor/healthy" }),
      summary({ repo: "vendor/failing", pass_rate: 0.5, successes: 50 }),
      summary({ repo: "pytorch/crcr-test", pass_rate: 0 }),
      summary({ repo: "vendor/l2", pass_rate: 0 }),
    ]);

    const res = await get();

    expect(res._status).toBe(200);
    expect(mockQuery).toHaveBeenCalledWith("crcr_l3_summary", { days: 7 });
    const byRepo = Object.fromEntries(
      res._json.repos.map((r: any) => [r.repo, r])
    );
    // Only real L3 backends: not the CRCR test repo, not L2.
    expect(Object.keys(byRepo).sort()).toEqual([
      "vendor/failing",
      "vendor/healthy",
      "vendor/silent",
    ]);
    expect(byRepo["vendor/healthy"]).toMatchObject({
      level: "L3",
      change: null,
      noData: false,
      windowDays: 7,
    });
    expect(byRepo["vendor/healthy"].criteria.every((c: any) => c.met)).toBe(
      true
    );
    expect(byRepo["vendor/failing"]).toMatchObject({
      change: "demote",
      noData: false,
      windowDays: 7,
    });
    expect(
      byRepo["vendor/failing"].criteria.filter((c: any) => c.met === false)
    ).toEqual([
      {
        criterion: "Job Pass Rate",
        measured: "50.0%",
        target: "≥ 90%",
        met: false,
      },
    ]);
    // Reported nothing over the window: demoted for silence, with nothing to
    // judge on any criterion.
    expect(byRepo["vendor/silent"]).toMatchObject({
      change: "demote",
      noData: true,
    });
    expect(
      byRepo["vendor/silent"].criteria.every((c: any) => c.met === null)
    ).toBe(true);
  });

  it("fails rather than judge without the summary", async () => {
    // A failed query must not read as "no jobs", which would put every L3
    // repo up for demotion.
    mockQuery.mockRejectedValue(new Error("clickhouse down"));
    const res = await get();
    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: "clickhouse down" });
  });

  it("fails when the allowlist cannot be read", async () => {
    mockFetchAllowlist.mockRejectedValue(new Error("github down"));
    const res = await get();
    expect(res._status).toBe(500);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("only accepts GET", async () => {
    const res = await get("POST");
    expect(res._status).toBe(405);
  });
});
