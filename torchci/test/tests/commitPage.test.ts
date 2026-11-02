import type { RunRecord } from "lib/api/tests/test/runs/types";
import {
  AUTO_LIMIT,
  autoLoads,
  COMMIT_TABLE_SORT_FIELDS,
  commitPageStateFromUrl,
  commitRunsApiUrl,
  commitSummaryApiUrl,
  commitTableRows,
  commitUrlParams,
  COMMON_STATUSES,
  gridChunks,
  PAGE_SIZE,
  runRowId,
  runStatus,
  STATUS_CHOICES,
  statusesSummary,
} from "lib/tests/commitPage";
import { noFacetValues } from "lib/tests/facets";

const REPO = "pytorch/pytorch";
const SHA = "ce6ff46d8ca967ef333ba9b804e081f26b432796";

function run(
  outcomes: RunRecord["attempts"][number]["outcome"][],
  id: string,
  environment = "env-1"
): RunRecord {
  return {
    github_workflow: {
      job_id: "1",
      run_id: "2",
      path: ".github/workflows/pull.yml",
      commit_sha: SHA,
      job_url: "https://github.com/pytorch/pytorch/actions/runs/2/job/1",
      job_name: "pull / linux-jammy-py3.10 / test (default, 1, 2, runner)",
      event: "push",
      pull_request: null,
    },
    test: null,
    environment: { id: environment } as RunRecord["environment"],
    env_vars: null,
    owners: [],
    attempts: outcomes.map((outcome, index) => ({
      id: `${id}-${index}`,
      report: { uuid: "00000000-0000-0000-0000-000000000000", s3_url: null },
      rerun_number: index,
      outcome,
      outcome_summary: "",
      started_at: `2026-10-30T12:0${index}:00.000Z`,
      ended_at: `2026-10-30T12:0${index}:30.000Z`,
    })),
  };
}

describe("the commit page's URL", () => {
  test("reads its defaults from an empty query and writes none back", () => {
    const state = commitPageStateFromUrl({});
    expect(state).toEqual({
      search: "",
      filters: noFacetValues(),
      statuses: ["failed", "timed_out", "flaky", "other"],
      sort: "-duration_milliseconds",
    });
    expect(
      Object.values(commitUrlParams(state)).every(
        (value) => value === undefined
      )
    ).toBe(true);
  });

  test("round-trips a view, the outcomes in status order", () => {
    const state = commitPageStateFromUrl({
      search: "test_add",
      status: ["skipped", "failed", "passed"],
      sort: "file,suite,case_name",
      owner: ["module: inductor"],
      test_config: "default",
      accelerator: ["cuda"],
    });
    expect(state.statuses).toEqual(["failed", "passed", "skipped"]);
    expect(state.sort).toBe("file,suite,case_name");
    expect(state.filters.owner).toEqual(["module: inductor"]);
    expect(state.filters.test_config).toEqual(["default"]);
    expect(state.filters.accelerator).toEqual(["cuda"]);
    const written = commitUrlParams(state);
    expect(written.search).toBe("test_add");
    // Comma-separated parameters are written joined, repeated ones as arrays.
    expect(written.status).toEqual(["failed", "passed", "skipped"]);
    expect(written.sort).toBe("file,suite,case_name");
    expect(written.owner).toEqual(["module: inductor"]);
    expect(commitPageStateFromUrl(written)).toEqual(state);
  });

  test("falls back to the defaults for a value the API would refuse", () => {
    const state = commitPageStateFromUrl({
      status: ["bogus"],
      sort: "-nothing",
    });
    expect(state.statuses).toEqual(["failed", "timed_out", "flaky", "other"]);
    expect(state.sort).toBe("-duration_milliseconds");
    // The outcome order is the page's, not the URL's to choose.
    expect(commitPageStateFromUrl({ sort: "status" }).sort).toBe(
      "-duration_milliseconds"
    );
  });

  test("names the API's endpoints with the view's parameters, the outcome order first", () => {
    expect(commitSummaryApiUrl(REPO, SHA)).toBe(
      `/api/tests/commit/${SHA}/summary?repo=pytorch%2Fpytorch`
    );
    const state = commitPageStateFromUrl({
      search: "add",
      owner: ["module: inductor"],
      sort: "-duration_milliseconds",
    });
    const url = new URL(commitRunsApiUrl(REPO, SHA, state, 100), "http://hud");
    expect(url.pathname).toBe(`/api/tests/commit/${SHA}`);
    expect(url.searchParams.getAll("status")).toEqual([
      "failed",
      "timed_out",
      "flaky",
      "other",
    ]);
    expect(url.searchParams.get("search")).toBe("add");
    expect(url.searchParams.getAll("owner")).toEqual(["module: inductor"]);
    expect(url.searchParams.get("sort")).toBe("-status,-duration_milliseconds");
    expect(url.searchParams.get("limit")).toBe("100");
    const byJob = commitPageStateFromUrl({
      sort: "job_name",
      status: "passed",
    });
    expect(
      new URL(
        commitRunsApiUrl(REPO, SHA, byJob, 100),
        "http://hud"
      ).searchParams.get("sort")
    ).toBe("-status,job_name");
  });

  test("the table's sortable columns map to API sort fields", () => {
    expect(Object.keys(COMMIT_TABLE_SORT_FIELDS)).toEqual([
      "name",
      "duration",
      "environment",
      "test_config",
      "job",
      "owners",
    ]);
    expect(COMMIT_TABLE_SORT_FIELDS.duration).toEqual([
      "duration_milliseconds",
    ]);
    expect(COMMIT_TABLE_SORT_FIELDS.job).toEqual(["job_name"]);
  });
});

describe("the outcomes", () => {
  test("the Outcome key is active whenever one of its choices is hidden", () => {
    expect(statusesSummary([...STATUS_CHOICES])).toBe("");
    expect(statusesSummary(["failed", "timed_out", "flaky", "other"])).toBe(
      "Failed, Timed out, Flaky and Other"
    );
    expect(STATUS_CHOICES).toEqual([
      "failed",
      "timed_out",
      "flaky",
      "passed",
      "skipped",
      "xfailed",
      "other",
    ]);
  });

  test("passes, expected failures and skips are the common statuses, off by default", () => {
    expect(COMMON_STATUSES).toEqual(["passed", "xfailed", "skipped"]);
    expect(runStatus(run(["failed", "passed"], "a"))).toBe("flaky");
    expect(runStatus(run(["skipped"], "b"))).toBe("skipped");
  });

  test("the page loads the next page by itself until the list reaches a common status or the limit", () => {
    expect(AUTO_LIMIT % PAGE_SIZE).toBe(0);
    expect(AUTO_LIMIT).toBeGreaterThanOrEqual(PAGE_SIZE);
    const problems = Array.from({ length: 100 }, (_unused, index) =>
      run(["failed"], `f${index}`)
    );
    expect(autoLoads(problems, true)).toBe(true);
    expect(autoLoads(problems, false)).toBe(false);
    // The last row loaded is a pass: the rest are passes too, on request.
    expect(autoLoads([...problems, run(["passed"], "p")], true)).toBe(false);
    expect(autoLoads([...problems, run(["xfailed"], "x")], true)).toBe(false);
    expect(autoLoads([...problems, run(["timed_out"], "t")], true)).toBe(true);
    expect(autoLoads([], true)).toBe(true);
    const many = Array.from({ length: AUTO_LIMIT }, (_unused, index) =>
      run(["failed"], `m${index}`)
    );
    expect(autoLoads(many, true)).toBe(false);
  });
});

describe("the table's rows", () => {
  const runs = [
    run(["failed", "failed", "failed"], "f1"),
    run(["timed_out", "skipped"], "t1"),
    run(["failed", "passed"], "k1", "env-a"),
    run(["failed", "passed"], "k2", "env-a"),
    run(["passed"], "p1", "env-b"),
  ];

  test("lists every run loaded in the API's order, then a Show more while a page follows", () => {
    const rows = commitTableRows({
      runs,
      loadingMore: false,
      hasMore: true,
      expanded: new Set(),
      sortedByEnvironment: false,
    });
    expect(rows.map((row) => row.kind)).toEqual([
      "run",
      "run",
      "run",
      "run",
      "run",
      "more",
    ]);
    expect(rows.map((row) => row.id)).toEqual([
      "f1-0",
      "t1-0",
      "k1-0",
      "k2-0",
      "p1-0",
      "more",
    ]);
    expect(runRowId(runs[0])).toBe("f1-0");
    const more = rows[rows.length - 1];
    expect(more.kind === "more" && more.loading).toBe(false);
    const loading = commitTableRows({
      runs,
      loadingMore: true,
      hasMore: true,
      expanded: new Set(),
      sortedByEnvironment: false,
    });
    const shimmer = loading[loading.length - 1];
    expect(shimmer.kind === "more" && shimmer.loading).toBe(true);
    expect(
      commitTableRows({
        runs,
        loadingMore: false,
        hasMore: false,
        expanded: new Set(),
        sortedByEnvironment: false,
      }).every((row) => row.kind === "run")
    ).toBe(true);
    expect(
      commitTableRows({
        runs: [],
        loadingMore: false,
        hasMore: false,
        expanded: new Set(),
        sortedByEnvironment: false,
      })
    ).toEqual([]);
  });

  test("sorted by environment, repeats of one environment are marked", () => {
    const rows = commitTableRows({
      runs,
      loadingMore: false,
      hasMore: false,
      expanded: new Set(),
      sortedByEnvironment: true,
    });
    expect(
      rows.map((row) => row.kind === "run" && row.environmentRepeated)
    ).toEqual([false, true, false, true, false]);
  });

  test("an expanded run lists its attempts in groups under it", () => {
    const rows = commitTableRows({
      runs: [run(["failed", "failed", "passed"], "x")],
      loadingMore: false,
      hasMore: false,
      expanded: new Set(["x-0"]),
      sortedByEnvironment: false,
    });
    expect(rows.map((row) => row.kind)).toEqual([
      "run",
      "attempts",
      "attempts",
    ]);
    const [runRow, firstGroup, secondGroup] = rows;
    expect(runRow.kind === "run" && runRow.expanded).toBe(true);
    expect(firstGroup.kind === "attempts" && firstGroup.group.last).toBe(2);
    expect(secondGroup.kind === "attempts" && secondGroup.group.outcome).toBe(
      "passed"
    );
    expect(rows.map((row) => row.id)).toEqual(["x-0", "x-0:1", "x-0:3"]);
  });
});

describe("the grid's row cap", () => {
  test("splits the rows into grids of at most a hundred, one empty grid for none", () => {
    const rows = Array.from({ length: 230 }, (_unused, index) => index);
    const chunks = gridChunks(rows);
    expect(chunks.map((chunk) => chunk.length)).toEqual([100, 100, 30]);
    expect(chunks[1][0]).toBe(100);
    expect(gridChunks([])).toEqual([[]]);
  });
});
