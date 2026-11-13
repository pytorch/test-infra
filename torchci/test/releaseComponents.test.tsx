import {
  ReleaseEvidenceCell,
  ReleaseLinksRow,
  ReleaseRcChip,
  ReleaseStatCard,
  ReleaseStatusChip,
  ReleaseTier,
} from "components/release/ReleaseComponents";
import { renderToStaticMarkup } from "react-dom/server";

describe("release components", () => {
  test("shows the supplied stat and uses the blocked accent", () => {
    const html = renderToStaticMarkup(
      <ReleaseStatCard accent="blocked" label="Blocking steps" value={2} />
    );

    expect(html).toContain("Blocking steps");
    expect(html).toContain(">2<");
    expect(html).toContain('data-testid="release-stat-blocked"');
  });

  test.each([
    ["done", "Done"],
    ["blocked", "Blocked"],
    ["in_progress", "In progress"],
    ["todo", "To do"],
  ] as const)("renders the %s status", (status, label) => {
    expect(
      renderToStaticMarkup(<ReleaseStatusChip status={status} />)
    ).toContain(label);
  });

  test("renders the tier and omits an unscoped RC chip", () => {
    const html = renderToStaticMarkup(
      <>
        <ReleaseTier tier="A" />
        <ReleaseRcChip rc={null} />
      </>
    );

    expect(html).toContain("Automation tier A");
    expect(html).not.toContain("RC");
  });

  test("normalizes the RC chip label", () => {
    expect(renderToStaticMarkup(<ReleaseRcChip rc="rc3" />)).toContain("RC3");
  });

  test("renders linked, unlinked and absent evidence", () => {
    expect(
      renderToStaticMarkup(
        <ReleaseEvidenceCell
          evidence={{ text: "Validation issue", url: "https://example.com" }}
        />
      )
    ).toContain('href="https://example.com"');
    expect(
      renderToStaticMarkup(
        <ReleaseEvidenceCell evidence={{ text: "Manual check", url: null }} />
      )
    ).toContain("Manual check");
    expect(
      renderToStaticMarkup(<ReleaseEvidenceCell evidence={null} />)
    ).toContain("Not checked");
    const unsafe = renderToStaticMarkup(
      <ReleaseEvidenceCell
        evidence={{ text: "Unsafe evidence", url: "javascript:alert(1)" }}
      />
    );
    expect(unsafe).toContain("Unsafe evidence");
    expect(unsafe).not.toContain("javascript:");
  });

  test("labels known links and filters unavailable ones", () => {
    const html = renderToStaticMarkup(
      <ReleaseLinksRow
        links={{
          tracker_issue: "https://example.com/tracker",
          release_notes: "https://example.com/notes",
          wheels: null,
          docs: "data:text/html,unsafe",
        }}
      />
    );

    expect(html).toContain("Tracker");
    expect(html).toContain("Release notes");
    expect(html).not.toContain("Wheels");
    expect(html).not.toContain("Docs");
    expect(html).not.toContain("data:text/html");
  });

  test("renders nothing when no release links are available", () => {
    expect(
      renderToStaticMarkup(<ReleaseLinksRow links={{ wheels: null }} />)
    ).toBe("");
  });
});
