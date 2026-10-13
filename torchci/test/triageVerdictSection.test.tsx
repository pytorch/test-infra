import { CollapsibleTriageVerdict } from "components/crcr/TriageVerdictSection";
import { renderToStaticMarkup } from "react-dom/server";

const VERDICT = {
  category: "upstream",
  confidence: "high",
  summary: "aten::foo lost its out= overload in #194610.",
  suspected_upstream: { pr: 194610, commit: "0e797b5a6acf" },
};

function render(verdictJson: string | null | undefined, prNumber?: number) {
  return renderToStaticMarkup(
    <CollapsibleTriageVerdict
      verdictJson={verdictJson}
      prNumber={prNumber}
      upstreamRepo="pytorch/pytorch"
    />
  );
}

describe("CollapsibleTriageVerdict", () => {
  test("shows the category on a collapsed line and the full verdict behind it", () => {
    const html = render(JSON.stringify(VERDICT), 194610);
    expect(html).toContain("<details");
    expect(html).toMatch(
      /<summary[^>]*>AI triage: upstream \(high\)<\/summary>/
    );
    expect(html).toContain("aten::foo lost its out= overload in #194610.");
    expect(html).toContain("(this PR)");
  });

  test("compares the suspected PR against the PR under test", () => {
    expect(render(JSON.stringify(VERDICT), 200001)).toContain("(not this PR)");
  });

  test.each([undefined, null, "", "{not json", '{"category":"compiler"}'])(
    "renders nothing for %p",
    (input) => {
      expect(render(input)).toBe("");
    }
  );
});
