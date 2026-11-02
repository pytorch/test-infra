import handler from "../pages/api/drci/advisorBadge";

// The static branch answers before any lookup; mock the lookups so a request
// that wrongly fell through to them is caught rather than reaching ClickHouse.
const mockQuery = jest.fn();
jest.mock("lib/clickhouse", () => ({
  queryClickhouseSaved: (...args: unknown[]) => mockQuery(...args),
}));
jest.mock("lib/advisor/advisorDispatch", () => ({
  autoDispatchEnabled: () => false,
  isValidSha: (s: string) => /^[0-9a-f]{40}$/.test(s),
  readDispatchStates: jest.fn(),
  toDispatchMark: jest.fn(),
}));

function call(query: Record<string, string>) {
  const res: any = {
    headers: {} as Record<string, string>,
    setHeader(k: string, v: string) {
      this.headers[k] = v;
    },
    status(code: number) {
      this.code = code;
      return this;
    },
    send(body: string) {
      this.body = body;
    },
  };
  return handler({ query } as any, res).then(() => res);
}

describe("advisorBadge route, verdict in the URL", () => {
  beforeEach(() => mockQuery.mockReset());

  test("draws the pill for a verdict and bucket without any lookup", async () => {
    const res = await call({ verdict: "not_related", confidence: "high" });
    expect(res.code).toBe(200);
    expect(res.headers["Content-Type"]).toContain("image/svg+xml");
    expect(res.headers["Cache-Control"]).toContain("max-age=86400");
    expect(res.body).toContain(">not related<");
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("the bucket moves the label", async () => {
    expect(
      (await call({ verdict: "related", confidence: "med" })).body
    ).toContain(">probably related<");
  });

  test.each([
    { verdict: "<script>", confidence: "high" },
    { verdict: "revert", confidence: "high" },
    { verdict: "not_related", confidence: "0.95" },
    { verdict: "not_related" },
  ])("a bad query %j gets a neutral pending pill, uncached", async (query) => {
    const res = await call(query as Record<string, string>);
    expect(res.code).toBe(200);
    expect(res.body).toContain(">pending<");
    expect(res.headers["Cache-Control"]).toBe("no-store");
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("without a verdict the job lookup is unchanged", async () => {
    mockQuery.mockResolvedValue([
      {
        verdict: "related",
        confidence: 0.95,
        timestamp: "2026-10-28 00:00:00",
      },
    ]);
    const res = await call({
      owner: "pytorch",
      repo: "pytorch",
      sha: "d".repeat(40),
      job: "Lint / lint",
    });
    expect(mockQuery).toHaveBeenCalled();
    expect(res.body).toBeDefined();
  });
});
