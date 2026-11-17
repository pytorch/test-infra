import type {
  ArtifactPage,
  ReleaseBoard,
  ReleaseIndex,
} from "lib/api/releases/types";
import {
  releaseIndexUrlForNotFound,
  type ReleaseResource,
} from "lib/releasePortal/api";
import { ReleaseIndexPageContent } from "pages/release";
import {
  artifactEndpoint,
  nextArtifactViewQuery,
  ReleaseArtifactsPageContent,
} from "pages/release/[version]/artifacts";
import { ReleaseBoardPageContent } from "pages/release/[version]/index";
import { renderToStaticMarkup } from "react-dom/server";

const retry = async () => {};

function resource<Answer>(
  data: Answer | undefined,
  error: unknown = undefined
): ReleaseResource<Answer> {
  return {
    data,
    error,
    isLoading: data === undefined && error === undefined,
    retry,
  };
}

const index: ReleaseIndex = {
  active: [
    {
      version: "2.16.0",
      phase: "RC build",
      blocking: 1,
      next_milestone: { name: "Final RC", date: "2026-12-07" },
    },
    {
      version: "2.15.1",
      phase: "Release day",
      blocking: 0,
      next_milestone: null,
    },
  ],
  releases: [
    {
      version: "2.16.0",
      type: "minor",
      branch: "release/2.16",
      ga_date: "2026-12-17",
      ga_planned: true,
      progress: { done: 3, total: 5 },
      phase: "RC build",
      status: "in_progress",
    },
    {
      version: "2.15.1",
      type: "patch",
      branch: "release/2.15",
      ga_date: null,
      ga_planned: true,
      progress: { done: 4, total: 5 },
      phase: "Release day",
      status: "blocked",
    },
  ],
  pagination: { next: null, previous: null },
};

const board: ReleaseBoard = {
  version: "2.16.0",
  type: "minor",
  branch: "release/2.16",
  phase: "RC build",
  current_rc: "rc3",
  links: {
    artifacts: "https://hud.pytorch.org/release/2.16.0/artifacts",
    docs: null,
    milestone: "https://github.com/pytorch/pytorch/milestone/1",
    tracker_issue: "https://github.com/pytorch/pytorch/issues/1",
    validation_issue: null,
  },
  stats: {
    done: 3,
    total: 5,
    blocking: 1,
    next_milestone: { name: "Final RC", date: "2026-12-07" },
    last_checked: "2026-11-13T00:00:00Z",
  },
  phases: [
    {
      id: 2,
      name: "RC build",
      collapsed: false,
      steps: [
        {
          id: "2.1",
          name: "Build RC binaries",
          tier: "A",
          owner: "release-manager",
          rc: "rc3",
          status: "blocked",
          informational: false,
          blocking: true,
          depends_on: [],
          due: "2026-12-01",
          runbook: null,
          evidence: {
            text: "One artifact is missing",
            url: "https://example.com/evidence",
          },
          manual: null,
          last_checked: "2026-11-13T00:00:00Z",
        },
        {
          id: "2.10",
          name: "No performance regressions",
          tier: "M",
          owner: "release-manager",
          rc: "rc3",
          status: "todo",
          informational: true,
          blocking: false,
          depends_on: [],
          due: null,
          runbook: null,
          evidence: null,
          manual: {
            what_to_check: "Benchmark runs show no regressions",
            link: "https://example.com/benchmarks",
          },
          last_checked: null,
        },
      ],
    },
  ],
};

const artifacts: ArtifactPage = {
  rc: "rc3",
  summary: {
    expected: 3,
    present: 1,
    missing: 1,
    size_anomalous: 1,
    unexpected: 1,
  },
  rows: [
    {
      package: "wheel",
      project: "missing-project",
      channel: "test",
      rc: "rc3",
      accelerator: "cpu",
      python: "3.12",
      os: "linux",
      arch: "x86_64",
      verdict: "missing",
      size_bytes: null,
      vs_previous_pct: null,
      evidence: { url: "https://example.com/wheel", http_status: 404 },
    },
    {
      package: "wheel",
      project: "size-anomaly-project",
      channel: "test",
      rc: "rc3",
      accelerator: "cu128",
      python: "3.13",
      os: "linux",
      arch: "x86_64",
      verdict: "size_anomalous",
      size_bytes: 910_000_000,
      vs_previous_pct: 41,
      evidence: { url: "https://example.com/anomaly", http_status: 200 },
    },
    {
      package: "docker",
      project: "unexpected-project",
      channel: "test",
      rc: "rc3",
      accelerator: "cpu",
      python: "",
      os: "linux",
      arch: "aarch64",
      verdict: "unexpected",
      size_bytes: 182_000_000,
      vs_previous_pct: 4,
      evidence: { url: "https://example.com/unexpected", http_status: 200 },
    },
    {
      package: "wheel",
      project: "present-project",
      channel: "test",
      rc: "rc3",
      accelerator: "cpu",
      python: "3.12",
      os: "linux",
      arch: "x86_64",
      verdict: "present",
      size_bytes: 190_000_000,
      vs_previous_pct: 1.2,
      evidence: { url: "https://example.com/present", http_status: 200 },
    },
  ],
  pagination: { next: null, previous: null },
};

describe("release routes", () => {
  test("renders the release index, active summaries, and its loading state", () => {
    expect(
      renderToStaticMarkup(
        <ReleaseIndexPageContent resource={resource<ReleaseIndex>(undefined)} />
      )
    ).toContain("Loading release data");

    const html = renderToStaticMarkup(
      <ReleaseIndexPageContent resource={resource(index)} />
    );
    expect(html).toContain("PyTorch releases");
    expect(html).toContain("Active releases");
    expect(html).toContain("Blocking");
    expect(html).toContain("Steps complete");
    expect(html).toContain("Not scheduled");
    expect(html).toContain("Release");
    expect(html).toContain("Branch");
    expect(html).toContain("To be confirmed");
    expect(html).toContain("2.16.0");
    expect(html).toContain("2.15.1");
    expect(html).toContain('href="/release/2.16.0"');
    expect(html).toContain('href="/release/2.15.1"');
    expect(html).toContain('aria-label="Open release 2.16.0 board"');
    expect(html).toContain('tabindex="0"');
  });

  test("renders empty and failed release indexes", () => {
    const empty = renderToStaticMarkup(
      <ReleaseIndexPageContent
        resource={resource({
          active: [],
          releases: [],
          pagination: { next: null, previous: null },
        })}
      />
    );
    expect(empty).toContain("No release data has been recorded yet.");

    const failed = renderToStaticMarkup(
      <ReleaseIndexPageContent
        resource={resource<ReleaseIndex>(undefined, {
          info: "The database is busy",
        })}
      />
    );
    expect(failed).toContain("Could not load releases");
    expect(failed).toContain("Retry");
  });

  test("says a release whose tag exists is completed", () => {
    const done: ReleaseIndex = {
      ...index,
      releases: [{ ...index.releases[0], status: "done", ga_planned: false }],
    };
    const html = renderToStaticMarkup(
      <ReleaseIndexPageContent resource={resource(done)} />
    );
    expect(html).toContain("release completed");
    expect(html).not.toContain("in progress");
  });

  test("renders the release board and an unknown-release state", () => {
    const html = renderToStaticMarkup(
      <ReleaseBoardPageContent
        version="2.16.0"
        board={resource(board)}
        index={resource(index)}
      />
    );
    expect(html).toContain("PyTorch 2.16.0 : RC build");
    expect(html).toContain("Tracker");
    expect(html).toContain("Validation unavailable");
    expect(html).toMatch(
      /data-testid="release-stat-blocked"[^]*?<span[^>]*>Blocking<\/span>[^]*?<div[^>]*>1<\/div>/
    );
    expect(html).toContain("3 / 5");
    expect(html).toContain("Final RC · 2026-12-07");
    expect(html).toContain("minor release · release/2.16 · RC3");
    expect(html).toContain("release-stat-blocked");
    expect(html).toContain("Build RC binaries");
    expect(html).toContain("Artifacts");
    // a step for information says "info", not a state, and what to look at
    expect(html).toContain("2.10 · No performance regressions");
    expect(html).toContain(">info<");
    expect(html).toContain('href="https://example.com/benchmarks"');
    expect(html).toContain("Benchmark runs show no regressions");

    const missing = renderToStaticMarkup(
      <ReleaseBoardPageContent
        version="9.9.9"
        board={resource<ReleaseBoard>(undefined, {
          status: 404,
          code: "not_found",
        })}
        index={resource(index)}
      />
    );
    expect(missing).toContain("Release 9.9.9 not found");
    expect(missing).toContain("Known: 2.16.0");
  });

  test("uses the board's released phase when unfinished steps remain", () => {
    const releasedBoard: ReleaseBoard = {
      ...board,
      version: "2.15.0",
      phase: "Released",
      current_rc: null,
      phases: [
        {
          ...board.phases[0],
          name: "Preparation and branch cut",
          steps: [
            {
              ...board.phases[0].steps[0],
              id: "1.1",
              name: "Post-release documentation",
              status: "todo",
            },
          ],
        },
      ],
    };

    const html = renderToStaticMarkup(
      <ReleaseBoardPageContent
        version="2.15.0"
        board={resource(releasedBoard)}
        index={resource(index)}
      />
    );

    expect(html).toContain("PyTorch 2.15.0 : Released");
    expect(html).toContain("Post-release documentation");
    expect(html).toContain(">todo<");
  });

  test("renders artifact data and a retryable load failure", () => {
    const html = renderToStaticMarkup(
      <ReleaseArtifactsPageContent
        version="2.16.0"
        artifacts={resource(artifacts)}
        index={resource(index)}
        onPrevious={undefined}
        onNext={undefined}
      />
    );
    expect(html).toContain("Release 2.16.0 artifacts");
    expect(html).toContain(
      "Showing final-release artifacts and test-channel observations for rc3."
    );
    expect(html).toContain("Expected");
    expect(html).toContain("Size-anomalous");
    expect(html).toContain("1 unexpected artifact in this selection.");
    expect(html).toContain("910 MB");
    expect(html).toContain("+41%");
    expect(html).toContain("Page size");
    expect(html).toContain("Showing 4 of 4 matching artifacts");
    expect(html.indexOf("missing-project")).toBeLessThan(
      html.indexOf("size-anomaly-project")
    );
    expect(html.indexOf("size-anomaly-project")).toBeLessThan(
      html.indexOf("unexpected-project")
    );
    expect(html.indexOf("unexpected-project")).toBeLessThan(
      html.indexOf("present-project")
    );

    const failed = renderToStaticMarkup(
      <ReleaseArtifactsPageContent
        version="2.16.0"
        artifacts={resource<ArtifactPage>(undefined, {
          info: "The database is busy",
        })}
        index={resource(index)}
        onPrevious={undefined}
        onNext={undefined}
      />
    );
    expect(failed).toContain("Could not load artifacts for release 2.16.0");
    expect(failed).toContain("Retry");

    const missing = renderToStaticMarkup(
      <ReleaseArtifactsPageContent
        version="9.9.9"
        artifacts={resource<ArtifactPage>(undefined, {
          status: 404,
          code: "not_found",
        })}
        index={resource(index)}
        onPrevious={undefined}
        onNext={undefined}
      />
    );
    expect(missing).toContain("Release 9.9.9 not found");
    expect(missing).toContain("Known: 2.16.0");
  });

  test("artifact filters and page size are shareable and reset the cursor", () => {
    const current = {
      channel: "test",
      os: "linux",
      package: "wheel",
      verdict: "missing",
      limit: "50",
      cursor: "opaque token",
    };
    expect(artifactEndpoint("2.16.0", current)).toBe(
      "/api/releases/2.16.0/artifacts?channel=test&os=linux&package=wheel&verdict=missing&limit=50&cursor=opaque+token"
    );
    expect(nextArtifactViewQuery(current, { os: "windows" })).toEqual({
      channel: "test",
      os: "windows",
      package: "wheel",
      verdict: "missing",
      limit: "50",
    });
    expect(nextArtifactViewQuery(current, { limit: "100" })).toEqual({
      channel: "test",
      os: "linux",
      package: "wheel",
      verdict: "missing",
      limit: "100",
    });
    expect(nextArtifactViewQuery(current, { verdict: "" })).toEqual({
      channel: "test",
      os: "linux",
      package: "wheel",
      limit: "50",
    });
    expect(nextArtifactViewQuery(current, { cursor: "next" }, true)).toEqual({
      ...current,
      cursor: "next",
    });
    expect(
      artifactEndpoint(
        "2.16.0",
        nextArtifactViewQuery(current, { cursor: "next" }, true)
      )
    ).toBe(
      "/api/releases/2.16.0/artifacts?channel=test&os=linux&package=wheel&verdict=missing&limit=50&cursor=next"
    );
  });

  test("artifact count follows the selected verdict", () => {
    const html = renderToStaticMarkup(
      <ReleaseArtifactsPageContent
        version="2.16.0"
        artifacts={resource({ ...artifacts, rows: [artifacts.rows[0]] })}
        index={resource(index)}
        query={{ verdict: "missing", limit: "100" }}
        onPrevious={undefined}
        onNext={undefined}
      />
    );
    expect(html).toContain("Showing 1 of 1 matching artifacts");
  });

  test("artifact caption reflects the selected channel, not only the API RC", () => {
    const render = (channel: string, page: ArtifactPage = artifacts) =>
      renderToStaticMarkup(
        <ReleaseArtifactsPageContent
          version="2.16.0"
          artifacts={resource(page)}
          index={resource(index)}
          query={{ channel }}
          onPrevious={undefined}
          onNext={undefined}
        />
      );

    const release = render("release");
    expect(release).toContain("Showing final-release artifacts.");
    expect(release).not.toContain("observations for rc3");
    expect(render("test")).toContain(
      "Showing test-channel observations for rc3."
    );
    expect(render("test", { ...artifacts, rc: null })).toContain(
      "No test-channel RC observations yet."
    );
  });

  test("fetches the release index only for an unknown release", () => {
    expect(releaseIndexUrlForNotFound("2.16.0", resource(board))).toBeNull();
    expect(
      releaseIndexUrlForNotFound(
        "9.9.9",
        resource<ReleaseBoard>(undefined, { status: 404, code: "not_found" })
      )
    ).toBe("/api/releases");
    expect(
      releaseIndexUrlForNotFound(
        "2.16.0",
        resource(board, { status: 404, code: "not_found" })
      )
    ).toBeNull();
  });

  test("renders unsafe evidence as text instead of a link", () => {
    const unsafeBoard = {
      ...board,
      links: {
        ...board.links,
        tracker_issue: "javascript:alert(1)",
      },
      phases: [
        {
          ...board.phases[0],
          steps: [
            {
              ...board.phases[0].steps[0],
              evidence: {
                text: "Unsafe evidence",
                url: "javascript:alert(1)",
              },
            },
          ],
        },
      ],
    };
    const unsafeArtifacts = {
      ...artifacts,
      rows: [
        {
          ...artifacts.rows[0],
          evidence: { url: "data:text/html,unsafe", http_status: 404 },
        },
      ],
    };

    const boardHtml = renderToStaticMarkup(
      <ReleaseBoardPageContent
        version="2.16.0"
        board={resource(unsafeBoard)}
        index={resource(index)}
      />
    );
    expect(boardHtml).toContain("Unsafe evidence");
    expect(boardHtml).toContain("Tracker unavailable");
    expect(boardHtml).not.toContain("javascript:");

    const artifactsHtml = renderToStaticMarkup(
      <ReleaseArtifactsPageContent
        version="2.16.0"
        artifacts={resource(unsafeArtifacts)}
        index={resource(index)}
        onPrevious={undefined}
        onNext={undefined}
      />
    );
    expect(artifactsHtml).toContain("HTTP 404");
    expect(artifactsHtml).not.toContain("data:text/html");
  });
});
