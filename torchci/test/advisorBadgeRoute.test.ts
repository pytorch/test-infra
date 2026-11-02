import * as clickhouse from "lib/clickhouse";
import handler from "pages/api/drci/advisorBadge";

jest.mock("lib/clickhouse", () => ({
  queryClickhouseSaved: jest.fn(),
  getClickhouseClientWritable: jest.fn(),
}));
jest.mock("lib/github", () => ({
  getOctokit: jest.fn(),
}));

const mockQuery = clickhouse.queryClickhouseSaved as jest.Mock;

const SHA = "a".repeat(40);
const JOB = "pull / linux-jammy-py3.10-gcc11 / test";
const RERUN_DONE = "2026-10-16 01:13:57";
// 13s after the rerun finished, but its evidence held only job 6.
const DISPATCHED_AT = "2026-10-16 01:14:10.000";

// One verdict after the dispatch; the dispatch row recorded `dispatchJobId`.
function setUp(dispatchJobId: number) {
  mockQuery.mockImplementation(async (name: string) => {
    if (name === "advisor_verdict_for_job") {
      return [
        {
          verdict: "not_related",
          confidence: 0.95,
          timestamp: "2026-10-16 01:15:00",
        },
      ];
    }
    if (name === "advisor_dispatch_states") {
      return [
        {
          signal_key: `dr_ci_${JOB}`,
          sr: ["dispatched", 0, String(dispatchJobId)],
          latest_version: DISPATCHED_AT,
        },
      ];
    }
    return [];
  });
}

async function badgeLabel(query: Record<string, string>): Promise<string> {
  let body = "";
  const res: any = {
    setHeader: jest.fn(),
    status: jest.fn(() => res),
    send: jest.fn((b: string) => {
      body = b;
    }),
  };
  await handler(
    {
      query: {
        owner: "pytorch",
        repo: "pytorch",
        sha: SHA,
        job: JOB,
        ...query,
      },
    } as any,
    res
  );
  return body.match(/<title>(.*)<\/title>/)?.[1] ?? "";
}

describe("advisorBadge route job_id", () => {
  afterEach(() => jest.resetAllMocks());

  it("does not show another run's verdict for the ingest-window rerun", async () => {
    setUp(6);
    expect(await badgeLabel({ since: RERUN_DONE, job_id: "7" })).toBe(
      "pending"
    );
    // Old URLs without job_id bind by time alone, as before.
    expect(await badgeLabel({ since: RERUN_DONE })).toBe("not related");
  });

  it("shows the verdict of the run the dispatch analyzed", async () => {
    setUp(7);
    expect(await badgeLabel({ since: RERUN_DONE, job_id: "7" })).toBe(
      "not related"
    );
    expect(await badgeLabel({ job_id: "7" })).toBe("not related");
  });

  it("binds by job_id alone when there is no since", async () => {
    setUp(6);
    expect(await badgeLabel({ job_id: "7" })).toBe("pending");
  });

  it("ignores an unusable job_id", async () => {
    setUp(6);
    expect(await badgeLabel({ since: RERUN_DONE, job_id: "7x" })).toBe(
      "not related"
    );
  });
});
