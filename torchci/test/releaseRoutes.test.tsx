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
import { ReleaseArtifactsPageContent } from "pages/release/[version]/artifacts";
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
  ],
  pagination: { next: null, previous: null },
};

const board: ReleaseBoard = {
  version: "2.16.0",
  type: "minor",
  branch: "release/2.16",
  current_rc: "rc3",
  links: {},
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
      ],
    },
  ],
};

const artifacts: ArtifactPage = {
  rc: "rc3",
  summary: {
    expected: 2,
    present: 1,
    missing: 1,
    size_anomalous: 0,
    unexpected: 0,
  },
  rows: [
    {
      package: "wheel",
      project: "torch",
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
  ],
  pagination: { next: null, previous: null },
};

describe("release routes", () => {
  test("renders the release index and its loading state", () => {
    expect(
      renderToStaticMarkup(
        <ReleaseIndexPageContent resource={resource<ReleaseIndex>(undefined)} />
      )
    ).toContain("Loading release data");

    const html = renderToStaticMarkup(
      <ReleaseIndexPageContent resource={resource(index)} />
    );
    expect(html).toContain("PyTorch releases");
    expect(html).toContain("2.16.0");
    expect(html).toContain("Open release board");
  });

  test("renders the release board and an unknown-release state", () => {
    const html = renderToStaticMarkup(
      <ReleaseBoardPageContent
        version="2.16.0"
        board={resource(board)}
        index={resource(index)}
      />
    );
    expect(html).toContain("Release 2.16.0");
    expect(html).toContain("Build RC binaries");
    expect(html).toContain("View release artifacts");

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
    expect(html).toContain("torch · wheel");
    expect(html).toContain("1/2 present");

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
