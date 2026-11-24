import type {
  CrcrRepo,
  ReleaseCrcr,
  ReleaseIndex,
} from "lib/api/releases/types";
import type { ReleaseResource } from "lib/releasePortal/api";
import { ReleaseCrcrPageContent } from "pages/release/[version]/crcr";
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
  active: [],
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

const failed: CrcrRepo = {
  repo: "vllm-project/vllm",
  level: "L2",
  rc: "rc9",
  result: "failed",
  summary: "3 of 212 jobs failed",
  failing_jobs: [
    {
      name: "Compile Unit Tests",
      url: "https://github.com/vllm-project/vllm/actions/runs/1/job/2",
    },
    { name: "Distributed Tests", url: null },
  ],
  owner: "vLLM CI oncall",
  run_url: "https://github.com/vllm-project/vllm/actions/runs/1",
  finished_at: "2026-10-29T10:12:00Z",
  hud_url: null,
};

const silent: CrcrRepo = {
  repo: "Ascend/pytorch",
  level: "L3",
  rc: "rc9",
  result: "no_result",
  summary: "No result reported for rc9",
  failing_jobs: [],
  owner: "Ascend CI oncall",
  run_url: null,
  finished_at: null,
  hud_url: null,
};

const passed: CrcrRepo = {
  repo: "sgl-project/sglang",
  level: "L2",
  rc: "rc9",
  result: "passed",
  summary: "48 of 48 jobs passed",
  failing_jobs: [],
  owner: "SGLang CI oncall",
  run_url: "https://github.com/sgl-project/sglang/actions/runs/7",
  finished_at: "2026-10-29T08:00:00Z",
  hud_url: null,
};

const crcr: ReleaseCrcr = {
  rc: "rc9",
  summary: { repos: 3, passing: 1, failing: 1, no_result: 1 },
  repos: [failed, silent, passed],
};

function render(
  data: ReleaseCrcr | undefined,
  error: unknown = undefined,
  version = "2.16.0"
) {
  return renderToStaticMarkup(
    <ReleaseCrcrPageContent
      version={version}
      crcr={resource(data, error)}
      index={resource(index)}
    />
  );
}

describe("release downstream validation page", () => {
  test("shows the counts and the repos, in the order the API gave them", () => {
    const html = render(crcr);
    expect(html).toContain("PyTorch 2.16.0 : Downstream validation");
    expect(html).toContain(
      "Results against RC9, the current release candidate."
    );
    expect(html).toMatch(
      /data-testid="release-stat-blocked"[^]*?<span[^>]*>Failing<\/span>[^]*?<div[^>]*>1<\/div>/
    );
    for (const label of [
      "Downstream repos",
      "Passing",
      "Failing",
      "No result",
    ]) {
      expect(html).toContain(`>${label}<`);
    }
    // A repo of the API's order is not re-sorted by the page.
    expect(html.indexOf("vllm-project/vllm")).toBeLessThan(
      html.indexOf("Ascend/pytorch")
    );
    expect(html.indexOf("Ascend/pytorch")).toBeLessThan(
      html.indexOf("sgl-project/sglang")
    );
    expect(html).toContain("Informational.");
    expect(html).toContain("RFC-0050");
    expect(html).not.toContain("Running");
  });

  test("a failed repo lists its failing jobs, each linked when it has a log", () => {
    const html = render(crcr);
    expect(html).toContain("3 of 212 jobs failed");
    expect(html).toContain("Failing jobs:");
    expect(html).toContain(
      'href="https://github.com/vllm-project/vllm/actions/runs/1/job/2"'
    );
    expect(html).toContain("Compile Unit Tests");
    // a job the downstream reported without a log link is text, not a dead link
    expect(html).toContain("Distributed Tests");
    expect(html).not.toMatch(/<a[^>]*>Distributed Tests<\/a>/);
    expect(html).toContain("Owner: vLLM CI oncall");
    expect(html).toContain(
      'href="https://github.com/vllm-project/vllm/actions/runs/1"'
    );
    expect(html).toContain('dateTime="2026-10-29T10:12:00Z"');
    expect(html).toContain("Oct 29, 2026");
  });

  test("a passed repo has no failing jobs row and no owner line", () => {
    const html = render({
      ...crcr,
      summary: { repos: 1, passing: 1, failing: 0, no_result: 0 },
      repos: [passed],
    });
    expect(html).toContain(">Passed<");
    expect(html).toContain("48 of 48 jobs passed");
    expect(html).not.toContain("Failing jobs:");
    expect(html).not.toContain("Owner:");
    // no failing repo, no red accent
    expect(html).not.toContain("release-stat-blocked");
  });

  test("an opted-in repo with nothing reported shows as no result", () => {
    const html = render(crcr);
    expect(html).toContain(">No result<");
    expect(html).toContain("No result reported for rc9");
    expect(html).toContain("Owner: Ascend CI oncall");
    // it has no run and no time to show
    expect(html).not.toContain("Run unavailable");
    expect(html).not.toContain("Not reported");
  });

  test("a passed or failed run without a link says so", () => {
    const html = render({
      ...crcr,
      summary: { repos: 1, passing: 1, failing: 0, no_result: 0 },
      repos: [{ ...passed, run_url: null, finished_at: null }],
    });
    expect(html).toContain("Run unavailable");
    expect(html).toContain("Not reported");
  });

  test("links the repo's HUD view only when the API has one", () => {
    expect(render(crcr)).not.toContain("Repo on HUD");
    const html = render({
      ...crcr,
      repos: [
        {
          ...passed,
          hud_url:
            "https://hud.pytorch.org/crcr/sgl-project/sglang?event=release&version=2.16.0",
        },
      ],
    });
    expect(html).toContain("Repo on HUD");
    expect(html).toContain(
      'href="https://hud.pytorch.org/crcr/sgl-project/sglang?event=release&amp;version=2.16.0"'
    );
  });

  test("a release with no release candidate recorded says so", () => {
    const html = render({
      rc: null,
      summary: { repos: 0, passing: 0, failing: 0, no_result: 0 },
      repos: [],
    });
    expect(html).toContain(
      "No release candidate has been recorded for downstream validation yet."
    );
    expect(html).not.toContain("<table");
  });

  test("a release candidate with no repos listed says so", () => {
    const html = render({
      rc: "rc10",
      summary: { repos: 0, passing: 0, failing: 0, no_result: 0 },
      repos: [],
    });
    expect(html).toContain("No downstream repos are listed for RC10 yet.");
    expect(html).not.toContain("<table");
  });

  test("renders unsafe links as text", () => {
    const html = render({
      ...crcr,
      repos: [
        {
          ...failed,
          run_url: "javascript:alert(1)",
          failing_jobs: [{ name: "Unsafe job", url: "data:text/html,unsafe" }],
        },
      ],
    });
    expect(html).toContain("Unsafe job");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:text/html");
  });

  test("loading, a failed load and an unknown release", () => {
    expect(
      renderToStaticMarkup(
        <ReleaseCrcrPageContent
          version="2.16.0"
          crcr={resource<ReleaseCrcr>(undefined)}
          index={resource(index)}
        />
      )
    ).toContain("Loading release data");

    const failedLoad = render(undefined, { info: "The database is busy" });
    expect(failedLoad).toContain(
      "Could not load downstream validation for release 2.16.0"
    );
    expect(failedLoad).toContain("The database is busy");
    expect(failedLoad).toContain("Retry");

    const missing = render(
      undefined,
      { status: 404, code: "not_found" },
      "9.9.9"
    );
    expect(missing).toContain("Release 9.9.9 not found");
    expect(missing).toContain("Known: 2.16.0");
  });
});
