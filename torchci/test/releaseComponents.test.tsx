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
    const emptyLabel = renderToStaticMarkup(
      <ReleaseEvidenceCell
        evidence={{ text: "  ", url: "https://example.com/evidence" }}
      />
    );
    expect(emptyLabel).toContain("Open evidence");
    expect(emptyLabel).toContain('href="https://example.com/evidence"');
    expect(
      renderToStaticMarkup(
        <ReleaseEvidenceCell evidence={{ text: "", url: null }} />
      )
    ).toContain("—");
  });

  test("labels known links and marks unavailable links", () => {
    const html = renderToStaticMarkup(
      <ReleaseLinksRow
        links={{
          tracker_issue: "https://example.com/tracker",
          release_notes: "https://example.com/notes",
          wheels: null,
          docs: "data:text/html,unsafe",
          docker_image: "https://hub.docker.com/r/pytorch/pytorch",
        }}
      />
    );

    expect(html).toContain("Tracker");
    expect(html).toContain("Release notes");
    expect(html).toContain("Docker Image");
    expect(html).toContain('href="https://hub.docker.com/r/pytorch/pytorch"');
    expect(html).toContain("Wheels unavailable");
    expect(html).toContain("Docs unavailable");
    expect(html).not.toContain("data:text/html");
  });

  test("renders unavailable labels when no release links are available", () => {
    const html = renderToStaticMarkup(
      <ReleaseLinksRow links={{ wheels: null }} />
    );

    expect(html).toContain("Tracker unavailable");
    expect(html).toContain("Wheels unavailable");
  });
});
