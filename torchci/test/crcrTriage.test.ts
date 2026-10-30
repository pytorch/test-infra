import {
  buildCrcrTriageLines,
  crcrBadgeUrl,
  renderCrcrTriageLine,
  toAdvisorVerdict,
} from "../lib/crcr/crcrTriage";
import { TriageVerdict } from "../lib/crcr/triageVerdict";
import { RecentWorkflowsData } from "../lib/types";
import { getDummyJob } from "./utils";

const PR = 202185;

function verdict(overrides: Partial<TriageVerdict> = {}): TriageVerdict {
  return {
    schema_version: 1,
    category: "backend",
    confidence: "high",
    summary: "NPU kernel registration regressed in the backend repo.",
    ...overrides,
  };
}

function l4Job(
  v: TriageVerdict | string | null,
  overrides: Partial<RecentWorkflowsData> = {}
): RecentWorkflowsData {
  return getDummyJob({
    id: 1,
    name: "crcr/org/l4-repo/CI/test",
    conclusion: "failure",
    downstreamLevel: "L4",
    downstreamRepo: "org/l4-repo",
    triageVerdictJson:
      v === null ? "" : typeof v === "string" ? v : JSON.stringify(v),
    ...overrides,
  });
}

describe("toAdvisorVerdict", () => {
  const map = (overrides: Partial<TriageVerdict>) => {
    const { verdict, confidence } = toAdvisorVerdict(verdict_(overrides), PR);
    return [verdict, confidence];
  };
  const verdict_ = verdict;

  test.each([
    ["backend", {}, ["not_related", "high"]],
    ["infra", {}, ["infra_issue", "high"]],
    ["flake", {}, ["garbage", "high"]],
    ["unknown", {}, ["unsure", "high"]],
    ["upstream", { suspected_upstream: { pr: 1 } }, ["not_related", "high"]],
    ["upstream", { suspected_upstream: { pr: PR } }, ["related", "high"]],
  ])("%s %j maps to %j", (category, overrides, expected) => {
    expect(map({ category, ...overrides } as Partial<TriageVerdict>)).toEqual(
      expected
    );
  });

  test("upstream with no PR named is related, at the reported confidence", () => {
    expect(map({ category: "upstream" })).toEqual(["related", "high"]);
    expect(
      map({
        category: "upstream",
        suspected_upstream: { commit: "0e797b5a6acf" },
      })
    ).toEqual(["related", "high"]);
    expect(map({ category: "upstream", confidence: "low" })).toEqual([
      "related",
      "low",
    ]);
  });

  test("the reported confidence word becomes the advisor's high / med / low", () => {
    expect(map({ confidence: "medium" })).toEqual(["not_related", "med"]);
    expect(map({ confidence: "low" })).toEqual(["not_related", "low"]);
  });
});

describe("renderCrcrTriageLine", () => {
  const HUD = "https://hud.pytorch.org";
  const RUN = "https://github.com/org/l4-repo/actions/runs/123";
  const render = (v: TriageVerdict, runUrl = RUN) =>
    renderCrcrTriageLine(v, HUD, "pytorch", "pytorch", PR, runUrl);

  test("has the shape of the in-tree 'AI verdict:' line", () => {
    const line = render(verdict({ analyzer: { name: "ascend-ci-triage" } }));
    expect(line).toContain(
      `<details><summary>AI verdict: <a href="${RUN}"><img alt="AI verdict: not related" src="${HUD}/api/drci/crcrBadge?verdict=not_related&amp;confidence=high"></a></summary><blockquote>`
    );
    expect(line).toContain("NPU kernel registration regressed");
    expect(line).toContain(
      "Verdict from the downstream repo's triage (ascend-ci-triage)."
    );
    expect(line).toContain(`<a href="${RUN}">Full log details &rarr;</a>`);
    expect(line).not.toContain("Full reasoning on HUD");
    expect(line.endsWith("</blockquote></details>\n")).toBe(true);
  });

  test.each([
    [{ category: "infra" }, "infra issue"],
    [{ category: "flake" }, "garbage"],
    [{ category: "unknown" }, "inconclusive"],
    [{ confidence: "medium" }, "probably not related"],
    [{ confidence: "low" }, "not related (uncertain)"],
    [{ category: "upstream", suspected_upstream: { pr: 1 } }, "not related"],
    [{ category: "upstream", suspected_upstream: { pr: PR } }, "related"],
    [{ category: "upstream" }, "related"],
    [{ category: "upstream", confidence: "medium" }, "probably related"],
  ])("%j is labelled %s", (overrides, label) => {
    expect(render(verdict(overrides as Partial<TriageVerdict>))).toContain(
      `alt="AI verdict: ${label}"`
    );
  });

  test.each(["", "test url", "javascript:alert(1)", "ftp://x.test/run"])(
    "an unusable run URL %j drops the links but keeps the verdict",
    (runUrl) => {
      const line = render(verdict(), runUrl);
      expect(line).not.toContain("<a href");
      expect(line).not.toContain("Full log details");
      expect(line).toContain('<img alt="AI verdict: not related"');
    }
  );

  test("escapes the run URL into the href", () => {
    const line = render(verdict(), 'https://x.test/run?a=1&b="2"');
    expect(line).toContain(
      '<a href="https://x.test/run?a=1&amp;b=&quot;2&quot;">'
    );
  });

  test("links a suspected upstream PR and gives its reason", () => {
    const line = render(
      verdict({
        category: "upstream",
        suspected_upstream: { pr: 194610, reason: "signature change" },
      })
    );
    expect(line).toContain(
      'Suspected upstream change: <a href="https://github.com/pytorch/pytorch/pull/194610">#194610</a> (signature change)'
    );
  });

  test("escapes the self-reported text and keeps it on one line", () => {
    const line = render(
      verdict({
        summary: "line one\n</blockquote></details><img src=x>",
        analyzer: { name: "<b>x</b>" },
      })
    );
    expect(line).not.toContain("<img src=x>");
    expect(line).toContain(
      "line one &lt;/blockquote&gt;&lt;/details&gt;&lt;img src=x&gt;"
    );
    expect(line).toContain("(&lt;b&gt;x&lt;/b&gt;)");
  });
});

describe("crcrBadgeUrl", () => {
  test("carries the advisor-style verdict and score", () => {
    expect(
      crcrBadgeUrl("https://hud.pytorch.org", {
        verdict: "infra_issue",
        confidence: "med",
      })
    ).toBe(
      "https://hud.pytorch.org/api/drci/crcrBadge?verdict=infra_issue&confidence=med"
    );
  });
});

describe("buildCrcrTriageLines", () => {
  test("renders a line only for jobs with a valid verdict", () => {
    const lines = buildCrcrTriageLines(
      [l4Job(verdict(), { id: 1 }), l4Job(null, { id: 2 })],
      "https://hud.pytorch.org",
      "pytorch",
      "pytorch",
      PR
    );
    expect([...lines.keys()]).toEqual([1]);
  });
});
