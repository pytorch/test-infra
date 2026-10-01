import {
  isSuspectedPrUnderTest,
  parseTriageVerdict,
  TriageVerdict,
} from "../lib/crcr/triageVerdict";

// Shape as the relay forwards it: already validated and normalized.
const VERDICT: TriageVerdict = {
  category: "upstream",
  confidence: "high",
  summary: "aten::foo lost its out= overload in #194610.",
  suspected_upstream: {
    pr: 194610,
    commit: "0e797b5a6acf",
    reason: "signature change to aten::foo",
  },
  evidence: [
    {
      job: "build-npu",
      test: "test_foo_out_variant",
      log_url: "https://github.com/Ascend/pytorch/actions/runs/1/job/2",
      excerpt: "error: no matching function for call to 'foo'",
    },
  ],
  reproduced_on_retry: false,
  analyzer: { name: "ascend-ci-triage", version: "0.3.1" },
  analyzed_at: "2026-08-24T14:22:10Z",
};

function parseWith(overrides: Record<string, unknown>) {
  return parseTriageVerdict(JSON.stringify({ ...VERDICT, ...overrides }));
}

describe("parseTriageVerdict", () => {
  test("parses a relay-normalized verdict", () => {
    expect(parseTriageVerdict(JSON.stringify(VERDICT))).toEqual(VERDICT);
  });

  test("accepts a minimal verdict", () => {
    const minimal = { category: "flake", confidence: "low", summary: "flaky" };
    expect(parseTriageVerdict(JSON.stringify(minimal))).toEqual(minimal);
  });

  test.each([undefined, null, ""])("returns null for %p", (input) => {
    expect(parseTriageVerdict(input)).toBeNull();
  });

  test.each(["{not json", "[]", '"upstream"', "42"])(
    "returns null for non-object JSON %p",
    (input) => {
      expect(parseTriageVerdict(input)).toBeNull();
    }
  );

  test.each([
    ["an unknown category", { category: "compiler" }],
    ["an unknown confidence", { confidence: "certain" }],
    ["an empty summary", { summary: "  " }],
    ["a non-string summary", { summary: true }],
    ["a missing summary", { summary: undefined }],
    ["a non-integer PR", { suspected_upstream: { pr: 1.5 } }],
    ["a non-positive PR", { suspected_upstream: { pr: 0 } }],
    ["a non-hex commit", { suspected_upstream: { commit: "main" } }],
    ["non-array evidence", { evidence: { job: "build" } }],
    ["a non-boolean retry flag", { reproduced_on_retry: "no" }],
    ["a non-string analyzer field", { analyzer: { name: 7 } }],
    ["a null optional field", { analyzed_at: null }],
  ])("drops the whole verdict for %s", (_label, overrides) => {
    expect(parseWith(overrides)).toBeNull();
  });

  // React escapes text but renders any href scheme it is given.
  test.each([
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "/relative/path",
    "ftp://example.com/log",
  ])("drops the whole verdict for evidence log_url %p", (logUrl) => {
    expect(parseWith({ evidence: [{ job: "x", log_url: logUrl }] })).toBeNull();
  });

  test("accepts an http log_url", () => {
    const logUrl = "http://ci.example.com/job/1";
    expect(
      parseWith({ evidence: [{ log_url: logUrl }] })?.evidence?.[0].log_url
    ).toBe(logUrl);
  });

  test("ignores keys it does not know, like the relay", () => {
    const parsed = parseWith({
      future_field: { nested: true },
      analyzer: { name: "triage", runtime_ms: 1200 },
    });
    expect(parsed?.category).toBe("upstream");
  });
});

describe("isSuspectedPrUnderTest", () => {
  test("true when the verdict blames the PR under test", () => {
    expect(isSuspectedPrUnderTest(VERDICT, 194610)).toBe(true);
  });

  test("false when the verdict blames a different PR", () => {
    expect(isSuspectedPrUnderTest(VERDICT, 200001)).toBe(false);
  });

  test.each([undefined, null, 0])(
    "null without a PR under test (%p), e.g. nightly",
    (prNumber) => {
      expect(isSuspectedPrUnderTest(VERDICT, prNumber)).toBeNull();
    }
  );

  test("null when the verdict names only a commit", () => {
    const commitOnly: TriageVerdict = {
      ...VERDICT,
      suspected_upstream: { commit: "0e797b5a6acf" },
    };
    expect(isSuspectedPrUnderTest(commitOnly, 194610)).toBeNull();
  });
});
