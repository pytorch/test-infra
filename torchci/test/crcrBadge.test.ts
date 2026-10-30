import handler from "../pages/api/drci/crcrBadge";

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
  handler({ query } as any, res);
  return res;
}

describe("crcrBadge", () => {
  test("draws the advisor's pill for a verdict and confidence", () => {
    const res = call({ verdict: "not_related", confidence: "high" });
    expect(res.code).toBe(200);
    expect(res.headers["Content-Type"]).toContain("image/svg+xml");
    expect(res.headers["Cache-Control"]).toContain("max-age=86400");
    expect(res.body).toContain(">not related<");
    expect(res.body).toContain("#2da44e");
  });

  test("the confidence moves the label", () => {
    expect(call({ verdict: "related", confidence: "med" }).body).toContain(
      ">probably related<"
    );
  });

  test.each([
    {},
    { verdict: "<script>", confidence: "0.9" },
    { verdict: "revert", confidence: "0.9" },
    { verdict: "not_related", confidence: "0.95" },
    { verdict: "not_related", confidence: "medium" },
  ])("a bad query %j gets a neutral pending pill, uncached", (query) => {
    const res = call(query as Record<string, string>);
    expect(res.code).toBe(200);
    expect(res.body).toContain(">pending<");
    expect(res.headers["Cache-Control"]).toBe("no-store");
  });
});
