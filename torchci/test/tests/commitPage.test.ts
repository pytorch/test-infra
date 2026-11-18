import type { RunRecord } from "lib/api/tests/test/runs/types";
import {
  AUTO_LIMIT,
  autoLoads,
  COMMIT_TABLE_SORT_FIELDS,
  commitJobsApiUrl,
  commitPageStateFromUrl,
  commitRunsApiUrl,
  commitSummaryApiUrl,
  commitTableRows,
  commitUrlParams,
  COMMON_STATUSES,
  gridChunks,
  PAGE_SIZE,
  pickFilteredOut,
  pickFilterOf,
  runRowId,
  runStatus,
  sameView,
  STATUS_CHOICES,
  statusesSummary,
  testCountsOf,
} from "lib/tests/commitPage";
import { noFacetValues } from "lib/tests/facets";
import { buildTimeline, noCounts } from "lib/tests/timeline";
import { COMMIT_JOBS, COMMIT_TESTS } from "./timelineFixtures";

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
      pick: null,
    });
    expect(
      Object.values(commitUrlParams(state)).every(
        (value) => value === undefined
      )
    ).toBe(true);
  });

  test("round-trips a pick, which lists every outcome until told otherwise", () => {
    const test = {
      job_id: "101",
      file: "test/test_nn.py",
      suite: "TestNN",
      case_name: "test_add",
    };
    const state = commitPageStateFromUrl(test);
    expect(state.pick).toEqual({
      kind: "test",
      jobId: "101",
      file: "test/test_nn.py",
      suite: "TestNN",
      caseName: "test_add",
    });
    expect(state.statuses).toHaveLength(7);
    const written = commitUrlParams(state);
    expect(written).toMatchObject(test);
    expect(written.status).toBeUndefined();
    // The page's own default is not the usual list of a pick: it is written.
    expect(
      commitUrlParams({ ...state, statuses: ["failed", "flaky"] }).status
    ).toEqual(["failed", "flaky"]);
    expect(
      commitPageStateFromUrl({ workflow: "pull.yml", build: "linux" }).pick
    ).toEqual({ kind: "build", workflow: "pull.yml", build: "linux" });
    // A workflow's run and attempt, where it ran more than once.
    const rerun = {
      workflow: "pull.yml",
      run_id: "43916531820",
      run_attempt: "2",
      build: "linux",
    };
    const row = { workflow: "pull.yml", runId: "43916531820", attempt: 2 };
    expect(commitPageStateFromUrl(rerun).pick).toEqual({
      kind: "build",
      ...row,
      build: "linux",
    });
    expect(
      commitUrlParams({ ...state, pick: { kind: "workflow", ...row } })
    ).toMatchObject({ ...rerun, build: undefined });
    expect(
      commitPageStateFromUrl({ ...rerun, run_id: "x", run_attempt: "0" }).pick
    ).toEqual({ kind: "build", workflow: "pull.yml", build: "linux" });
    // A build needs its workflow, a file its job, and a job a real ID.
    expect(commitPageStateFromUrl({ build: "linux" }).pick).toBeNull();
    expect(
      commitPageStateFromUrl({ file: "a.py", job_id: "abc" }).pick
    ).toBeNull();
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
    expect(sameView(commitPageStateFromUrl(written), state)).toBe(true);
    expect(
      sameView({ ...state, pick: { kind: "job", jobId: "1" } }, state)
    ).toBe(false);
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
      `/api/tests/commit/${SHA}/summary?repo=pytorch%2Fpytorch&fields=commit&fields=retention_starts_at`
    );
    // The jobs and what their tests did, each asked for on its own.
    expect(
      (["jobs", "tests"] as const).map((field) =>
        commitJobsApiUrl(REPO, SHA, field)
      )
    ).toEqual(
      ["jobs", "tests"].map(
        (field) =>
          `/api/tests/commit/${SHA}/jobs?repo=pytorch%2Fpytorch&fields=${field}`
      )
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

  test("narrows the runs to a pick", () => {
    const timeline = buildTimeline(COMMIT_JOBS, COMMIT_TESTS, 0);
    const pull = ".github/workflows/pull.yml";
    expect(pickFilterOf(null, undefined)).toEqual({});
    expect(
      pickFilterOf({ kind: "file", jobId: "101", file: "a.py" }, undefined)
    ).toEqual({ jobIds: ["101"], file: "a.py" });
    // A workflow and a build wait for the jobs that say what they hold.
    const workflow = { kind: "workflow", workflow: pull } as const;
    const build = {
      ...workflow,
      kind: "build",
      build: "lintrunner / linux-job",
    } as const;
    expect(pickFilterOf(workflow, undefined)).toBe("waiting");
    expect(pickFilterOf(workflow, timeline)).toEqual({ workflowPath: pull });
    expect(pickFilterOf(build, timeline)).toEqual({ jobIds: ["103"] });
    // The jobs say it, before their tests are in.
    const jobsAlone = buildTimeline(COMMIT_JOBS, undefined, 0);
    expect(pickFilterOf(build, jobsAlone)).toEqual({ jobIds: ["103"] });
    expect(pickFilterOf({ ...build, build: "none" }, timeline)).toBe("nothing");
    // A workflow with a re-run is not its path: each of its rows is its jobs.
    const [first] = COMMIT_JOBS;
    const rerun = buildTimeline(
      [
        ...COMMIT_JOBS,
        {
          ...first,
          id: "109",
          workflow: { ...first.workflow, run_attempt: 2 },
        },
      ],
      COMMIT_TESTS,
      0
    );
    expect(pickFilterOf(workflow, rerun)).toEqual({
      jobIds: ["100", "101", "102", "103"],
    });
    expect(pickFilterOf({ ...workflow, attempt: 2 }, rerun)).toEqual({
      jobIds: ["109"],
    });

    const state = commitPageStateFromUrl({ workflow_path: ["a.yml", "b.yml"] });
    const params = (pick: Parameters<typeof commitRunsApiUrl>[4]) =>
      new URL(commitRunsApiUrl(REPO, SHA, state, 100, pick), "http://hud")
        .searchParams;
    const test = params({
      jobIds: ["101", "102"],
      file: "a.py",
      suite: "",
      caseName: "test_add",
    });
    expect(test.getAll("job_id")).toEqual(["101", "102"]);
    expect(
      ["file", "suite", "case_name"].map((name) => test.get(name))
    ).toEqual(["a.py", "", "test_add"]);
    // A picked workflow takes the place of the header's workflow filter,
    // which leaves it nothing to match when it leaves the workflow out.
    expect(params({ workflowPath: pull }).getAll("workflow_path")).toEqual([
      pull,
    ]);
    expect(pickFilteredOut(state.filters, { workflowPath: pull })).toBe(true);
    expect(pickFilteredOut(state.filters, { workflowPath: "a.yml" })).toBe(
      false
    );
    expect(pickFilteredOut(state.filters, { jobIds: ["101"] })).toBe(false);
  });

  test("sums up the tests of a pick from what the page has read", () => {
    const timeline = buildTimeline(COMMIT_JOBS, COMMIT_TESTS, 0);
    const read = { timeline, job: undefined, runs: undefined };
    expect(
      testCountsOf({ ...read, timeline: undefined, pick: null })
    ).toBeUndefined();
    // The jobs without their tests say nothing of them yet, not none.
    const jobsAlone = buildTimeline(COMMIT_JOBS, undefined, 0);
    for (const pick of [null, { kind: "job", jobId: "101" } as const]) {
      expect(
        testCountsOf({ ...read, timeline: jobsAlone, pick })
      ).toBeUndefined();
    }
    // The whole commit: every job's, a bot's with them.
    const whole = {
      ...noCounts(),
      failed: 1,
      flaky: 2,
      passed: 70,
      skipped: 5,
    };
    expect(testCountsOf({ ...read, pick: null })).toEqual(whole);
    const botTested = buildTimeline(
      COMMIT_JOBS,
      [...COMMIT_TESTS, { ...COMMIT_TESTS[1], job_id: "105" }],
      0
    );
    expect(testCountsOf({ ...read, timeline: botTested, pick: null })).toEqual({
      ...whole,
      passed: 100,
      skipped: 10,
    });
    expect(
      testCountsOf({ ...read, pick: { kind: "job", jobId: "101" } })
    ).toEqual({ ...noCounts(), failed: 1, flaky: 2, passed: 40 });
    expect(
      testCountsOf({
        ...read,
        pick: {
          kind: "build",
          workflow: ".github/workflows/pull.yml",
          build: "linux-jammy-py3.10-gcc11",
        },
      })?.passed
    ).toBe(70);
    const test = {
      kind: "test",
      jobId: "101",
      file: "a.py",
      suite: "",
      caseName: "test_add",
    } as const;
    expect(testCountsOf({ ...read, pick: test })).toBeUndefined();
    expect(
      testCountsOf({
        ...read,
        pick: test,
        runs: [run(["failed", "passed"], "a"), run(["passed"], "b")],
      })
    ).toEqual({ ...noCounts(), flaky: 1, passed: 1 });
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
