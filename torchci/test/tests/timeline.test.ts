import {
  bandPath,
  buildTimeline,
  jobFilterOf,
  jobVerdict,
  noCounts,
  nodeLabel,
  nodeOfPick,
  noTestsWords,
  otherFiles,
  pathTo,
  pickAbove,
  pickKey,
  pickOfNode,
  ribbonOf,
  rowsOnWay,
  rowsUnder,
  stepAt,
  stepCuts,
  Timeline,
  TimelineFile,
  timelineJob,
  TimelinePick,
  timelineSteps,
  trailOf,
  viewOf,
} from "lib/tests/timeline";
import {
  COMMIT_JOBS,
  COMMIT_TESTS,
  commitJob,
  TEST_JOB_TESTS,
  testJob,
} from "./timelineFixtures";

const NOW = Date.parse("2026-11-14T07:00:00Z") / 1000;
const PULL = ".github/workflows/pull.yml";
// The row of the pull workflow's one run and attempt.
const PULL_ROW = `${PULL}@7#1`;
const BUILD = "linux-jammy-py3.10-gcc11";

describe("a job on the clock", () => {
  test("queue takes the container step; the rest splits into tests, unaccounted and other steps", () => {
    const job = timelineJob(testJob, TEST_JOB_TESTS, NOW);
    expect(job.kind).toBe("tests");
    // Two minutes for a runner and 55 seconds for the container.
    expect(job.queue).toBe(175);
    expect(job.workStart - job.started).toBe(60);
    expect(job.run).toBe(58 * 60 - 55);
    expect(job.covered).toBe(15);
    expect(job.unaccounted).toBe(49 * 60 - 15);
    expect(job.other).toBe(job.run - 49 * 60);
    expect(job.covered + job.unaccounted + job.other).toBe(job.run);
    expect(job.failing).toBe(2);
    expect(job.bad).toBe("failed");
    expect([job.build, job.role, job.config, job.shard]).toEqual([
      BUILD,
      "test",
      "default",
      { index: 1, total: 2 },
    ]);
  });

  test("a job without a runner waits until now or until it ended, and a skipped one took no time", () => {
    const waiting = timelineJob(
      commitJob("1", "build", {
        status: "queued",
        conclusion: null,
        started_at: null,
        completed_at: null,
      }),
      null,
      NOW
    );
    expect(waiting.kind).toBe("waiting");
    expect(waiting.queue).toBe(2 * 3600);
    expect(waiting.run).toBe(0);
    // One that ended with no runner waited until it ended: none of its time
    // is running time, and it failed without having run.
    const untaken = commitJob("3", "build", {
      conclusion: "failure",
      started_at: null,
    });
    const ended = timelineJob(untaken, null, NOW);
    expect([ended.kind, ended.queue, ended.run]).toEqual(["waiting", 3600, 0]);
    expect(ended.workStart).toBe(ended.ended);
    expect(jobVerdict(ended).text).toBe("Failed while queued");
    const timeline = buildTimeline([untaken], [], NOW);
    expect(timeline.root.totals).toMatchObject({
      queue: 3600,
      run: 0,
      ran: 0,
      failed: 1,
    });
    expect(noTestsWords(timeline, { kind: "job", jobId: "3" })).toBe(
      "This job ended before a runner took it, so it ran no tests."
    );
    // Tests recorded for a job GitHub says no runner took count all the same.
    const recorded = buildTimeline(
      [untaken],
      [{ job_id: "3", ...TEST_JOB_TESTS }],
      NOW
    );
    expect(recorded.root.totals.counts.passed).toBe(40);
    const skipped = timelineJob(
      commitJob("2", "build", { conclusion: "skipped" }),
      null,
      NOW
    );
    expect([skipped.kind, skipped.queue, skipped.run]).toEqual([
      "skipped",
      0,
      0,
    ]);
  });

  test("a ribbon holds what its jobs' times add up to", () => {
    const job = timelineJob(testJob, TEST_JOB_TESTS, NOW);
    const ribbon = ribbonOf([job], job.created, job.ended);
    const total = (slices: Float32Array) =>
      slices.reduce((sum, share) => sum + share, 0) * ribbon.sliceSeconds;
    expect(total(ribbon.tests)).toBeCloseTo(job.covered, 3);
    expect(total(ribbon.unaccounted)).toBeCloseTo(job.unaccounted, 3);
    expect(total(ribbon.other)).toBeCloseTo(job.other, 3);
    expect(
      bandPath(
        () => 0,
        (slice) => ribbon.tests[slice],
        ribbon
      )
    ).toMatch(/^polygon\(/);
    // A layer with nothing in it is not drawn.
    expect(
      bandPath(
        () => 0,
        () => 0,
        ribbon
      )
    ).toBeNull();
  });

  test("a ribbon stands on a base wherever a job is running", () => {
    // Five slices: nothing; one job, half in tests, for two; the peak of
    // four, three of them in tests; nothing.
    const ribbon = {
      tests: Float32Array.of(0, 0.5, 0.5, 3, 0),
      unaccounted: Float32Array.of(0, 0.5, 0.5, 1, 0),
      other: new Float32Array(5),
      peak: 4,
      slices: 5,
      sliceSeconds: 60,
    };
    const tests = (slice: number) => ribbon.tests[slice];
    const all = (slice: number) => tests(slice) + ribbon.unaccounted[slice];
    // One job of the peak's four is a quarter of the track above the base
    // and the whole 2px base: a quarter of the track and 1.5px. The layers
    // halve it. At the peak the layers have the whole track between them,
    // and where nothing runs there is no base. A line steps only where its
    // height changes.
    expect(bandPath(tests, all, ribbon)).toBe(
      "polygon(" +
        "0.000% 100.00%,20.000% 100.00%," +
        "20.000% calc(75.00% - 1.50px),60.000% calc(75.00% - 1.50px)," +
        "60.000% 0.00%,80.000% 0.00%," +
        "80.000% 100.00%,100% 100.00%," +
        "100% 100.00%,80.000% 100.00%," +
        "80.000% 25.00%,60.000% 25.00%," +
        "60.000% calc(87.50% - 0.75px),20.000% calc(87.50% - 0.75px)," +
        "20.000% 100.00%,0.000% 100.00%)"
    );
  });
});

describe("an open job's steps", () => {
  const at = (time: string) => `2026-11-14T${time}.000Z`;
  const time = (clock: string) => Date.parse(at(clock)) / 1000;
  const step = (
    name: string,
    from: string | null,
    to: string | null,
    conclusion = "success"
  ) => ({
    name,
    conclusion,
    started_at: from === null ? null : at(from),
    completed_at: to === null ? null : at(to),
  });
  // The fixture's job: queued at 5:00, its container up at 5:03, its Test
  // step from 5:10 to 5:59, done at 6:00.
  const job = timelineJob(testJob, TEST_JOB_TESTS, NOW);
  const steps = timelineSteps(
    [
      step("Set up job", "05:02:00", "05:02:05"),
      step("Initialize containers", "05:02:05", "05:03:00"),
      step("Checkout PyTorch", "05:03:00", "05:08:00"),
      step("Setup Linux", "05:08:00", "05:10:00"),
      step("Test", "05:10:00", "05:59:00", "failure"),
      step("Upload artifacts", "05:59:00", "05:59:40"),
      step("Stop", "05:59:40", "05:59:40"),
      step("Teardown", "05:59:45", null),
      step("Post Checkout PyTorch", null, null),
      step("Print logs", "05:59:40", "05:59:40", "skipped"),
    ],
    job
  );

  test("are the steps that ran, one still running to the job's end", () => {
    expect(steps.map(({ name }) => name)).toEqual([
      "Set up job",
      "Initialize containers",
      "Checkout PyTorch",
      "Setup Linux",
      "Test",
      "Upload artifacts",
      "Stop",
      "Teardown",
    ]);
    expect(steps[2]).toMatchObject({
      start: time("05:03:00"),
      end: time("05:08:00"),
    });
    expect(steps[7].end).toBe(job.ended);
  });

  test("cut the job's bar where a step that shows ends, inside the bar and off the Test step's ends", () => {
    // Not after the container step, where the bar begins; not where the
    // Test step begins or ends; not after a step too short to show; and not
    // at the bar's own end.
    expect(stepCuts(steps, job)).toEqual([time("05:08:00"), time("05:59:40")]);
    const build = timelineJob(commitJob("100", "build"), null, NOW);
    expect(
      stepCuts(
        timelineSteps(
          [
            step("Checkout PyTorch", "05:02:00", "05:10:00"),
            step("Build", "05:10:00", "05:58:00"),
            step("Complete job", "05:58:00", "06:00:00"),
          ],
          build
        ),
        build
      )
    ).toEqual([time("05:10:00"), time("05:58:00")]);
  });

  test("a time falls in one step, the later of two that touch", () => {
    expect(stepAt(steps, time("05:05:00"))).toBe(2);
    expect(stepAt(steps, time("05:08:00"))).toBe(3);
    expect(stepAt(steps, time("05:59:50"))).toBe(7);
    // A step with no length answers for a second.
    expect(stepAt(steps, time("05:59:40") + 0.5)).toBe(6);
    expect(stepAt(steps, time("05:59:42"))).toBe(-1);
    expect(stepAt(steps, time("05:01:00"))).toBe(-1);
  });
});

describe("the timeline's rows", () => {
  const timeline = buildTimeline(COMMIT_JOBS, COMMIT_TESTS, NOW);
  const names = (id: string) =>
    rowsUnder(timeline.nodes.get(id)!).map(nodeLabel);

  test("fold the jobs by workflow and build, the small workflows and the bots apart", () => {
    expect(names("root")).toEqual([
      "pull",
      "1 smaller workflow",
      "Bots and uploads",
    ]);
    // A job that is a build of its own stands for its build.
    expect(names(`workflow:${PULL_ROW}`)).toEqual([
      BUILD,
      "lintrunner / linux-job",
    ]);
    expect(names(`build:${PULL_ROW}:${BUILD}`)).toEqual([
      "build",
      "default · shard 1 of 2",
      "default · shard 2 of 2",
    ]);
    expect(names("small")).toEqual(["lint"]);
    // The bots' jobs are not the commit's own: its totals and clock leave
    // them out.
    expect(timeline.root.totals.jobs).toBe(5);
    expect(timeline.nodes.get("bots")!.totals.jobs).toBe(1);
    expect(timeline.root.totals.failed).toBe(1);
    expect(timeline.root.totals.counts.passed).toBe(70);
  });

  test("a pick names its row, and steps back a level at a time", () => {
    const picks: TimelinePick[] = [
      {
        kind: "test",
        jobId: "101",
        file: "test/test_nn.py",
        suite: "TestNN",
        caseName: "test_add",
      },
      { kind: "file", jobId: "101", file: "test/test_nn.py" },
      { kind: "job", jobId: "101" },
      { kind: "build", workflow: PULL, build: BUILD },
      { kind: "workflow", workflow: PULL },
    ];
    picks.forEach((pick, index) => {
      expect(pickAbove(timeline, pick)).toEqual(picks[index + 1] ?? null);
    });
    const job = nodeOfPick(timeline, picks[0])!;
    expect(pathTo(job).map((row) => row.id)).toEqual([
      "root",
      `workflow:${PULL_ROW}`,
      `build:${PULL_ROW}:${BUILD}`,
      "job:101",
    ]);
    expect(pickOfNode(job)).toEqual(picks[2]);
    // The fold rows are not picks.
    expect(pickOfNode(timeline.root)).toBeNull();
    expect(pickOfNode(timeline.nodes.get("small")!)).toBeNull();
    expect(pickKey(picks[2])).toBe(pickKey({ jobId: "101", kind: "job" }));
    expect(pickKey(picks[2])).not.toBe(pickKey(picks[1]));
  });

  test("with a job open, a row on the way keeps the row that leads on and folds its others into a line", () => {
    // The rows under a row on the way to a job: the one kept, and the line
    // for the others by its ID, its name, its rows, and how many of them
    // failed or were flaky.
    const rows = (of: Timeline, rowId: string, jobId: string) => {
      const onPath = new Set(
        pathTo(of.nodes.get(`job:${jobId}`)!).map((row) => row.id)
      );
      const way = rowsOnWay(of.nodes.get(rowId)!, onPath);
      if (way === null) return null;
      const { kept, others } = way;
      return [
        nodeLabel(kept),
        others === null
          ? null
          : [
              others.id,
              others.name,
              others.rows.map(nodeLabel),
              others.failed,
              others.flaky,
            ],
      ];
    };
    expect(rows(timeline, "root", "102")).toEqual([
      "pull",
      [
        "others:root",
        "Other workflows",
        ["1 smaller workflow", "Bots and uploads"],
        0,
        0,
      ],
    ]);
    // A lone job stands for its build, and is counted as one.
    expect(rows(timeline, `workflow:${PULL_ROW}`, "102")).toEqual([
      BUILD,
      [
        `others:workflow:${PULL_ROW}`,
        "1 other build",
        ["lintrunner / linux-job"],
        0,
        0,
      ],
    ]);
    // The line says what its rows did: the first shard failed.
    expect(rows(timeline, `build:${PULL_ROW}:${BUILD}`, "102")).toEqual([
      "default · shard 2 of 2",
      [
        `others:build:${PULL_ROW}:${BUILD}`,
        "2 other jobs",
        ["build", "default · shard 1 of 2"],
        1,
        0,
      ],
    ]);
    // A row with no other has no line, and a row off the way keeps its rows.
    expect(rows(timeline, "small", "104")).toEqual(["lint", null]);
    expect(rows(timeline, "root", "104")).toEqual([
      "1 smaller workflow",
      ["others:root", "Other workflows", ["pull", "Bots and uploads"], 1, 0],
    ]);
    expect(rows(timeline, "bots", "104")).toBeNull();
    // Under the smaller workflows' row and the bots' the others are
    // workflows, and under a bot's workflow, which has no builds, jobs.
    const upload = {
      run_id: "9",
      run_attempt: 1,
      name: "Upload test stats",
      path: ".github/workflows/upload-test-stats.yml",
      event: "workflow_run",
    };
    const more = buildTimeline(
      [
        ...COMMIT_JOBS,
        // Twenty seconds: too small for a row of its own, as lint is.
        commitJob(
          "106",
          "another-check",
          {
            started_at: "2026-11-14T05:02:00.000Z",
            completed_at: "2026-11-14T05:02:20.000Z",
          },
          "docs"
        ),
        commitJob("107", "Upload test stats for 43579122302, attempt 1", {
          workflow: upload,
        }),
        commitJob("108", "Update viable/strict", {
          workflow: {
            ...upload,
            name: "Update viable/strict",
            path: ".github/workflows/update-viablestrict.yml",
          },
        }),
      ],
      COMMIT_TESTS,
      NOW
    );
    expect(rows(more, "small", "104")?.[1]).toEqual([
      "others:small",
      "1 other workflow",
      ["docs"],
      0,
      0,
    ]);
    expect(rows(more, "bots", "105")?.[1]).toEqual([
      "others:bots",
      "1 other workflow",
      ["Update viable/strict"],
      0,
      0,
    ]);
    expect(
      rows(more, "workflow:.github/workflows/upload-test-stats.yml", "105")?.[1]
    ).toEqual([
      "others:workflow:.github/workflows/upload-test-stats.yml",
      "1 other job",
      ["Upload test stats for 43579122302, attempt 1"],
      0,
      0,
    ]);
  });

  test("a line of folded files counts them, and the failed and flaky among them", () => {
    const file = (path: string, status: TimelineFile["status"]) => ({
      path,
      name: path,
      runs: [],
      failing: 0,
      counts: noCounts(),
      tests: 1,
      duration: 1,
      start: 0,
      end: 1,
      status,
    });
    expect(otherFiles("job:101", [])).toBeNull();
    expect(
      otherFiles("job:101", [
        file("test/test_a.py", "failed"),
        file("test/test_b.py", "passed"),
        file("test/test_c.py", "flaky"),
      ])
    ).toMatchObject({
      id: "others:job:101",
      name: "3 other files",
      failed: 1,
      flaky: 1,
    });
    expect(
      otherFiles("files:101", [file("test/test_a.py", "passed")])?.name
    ).toBe("1 other file");
  });

  test("the title names a pick by the rows' own names", () => {
    expect(
      trailOf(timeline, {
        kind: "test",
        jobId: "101",
        file: "test/test_nn.py",
        suite: "TestNN",
        caseName: "test_add",
      }).map(({ label, code }) => [label, code])
    ).toEqual([
      ["pull", false],
      [BUILD, false],
      ["default · shard 1 of 2", false],
      ["test_nn.py", true],
      ["test_add", true],
    ]);
    // A lone job stands for its build, and a row the commit does not have
    // goes by the URL's words.
    expect(
      trailOf(timeline, { kind: "job", jobId: "103" }).map(({ label }) => label)
    ).toEqual(["pull", "lintrunner / linux-job"]);
    expect(trailOf(timeline, { kind: "job", jobId: "9" })[0].label).toBe(
      "Job 9"
    );
    expect(trailOf(timeline, null)).toEqual([]);
  });

  test("the Job filter lists the jobs with tests under their workflows, and holds the pick", () => {
    const pull = `workflow:${PULL_ROW}`;
    expect(jobFilterOf(timeline, null)).toEqual({
      sections: [
        {
          facet: pull,
          title: "pull",
          options: [
            { value: "101", label: `${BUILD} · default · shard 1 of 2` },
            { value: "102", label: `${BUILD} · default · shard 2 of 2` },
          ],
        },
      ],
      value: { [pull]: [] },
      summary: "",
    });
    // A file of a job is held as its job, a build as its jobs.
    const onFile = jobFilterOf(timeline, {
      kind: "file",
      jobId: "101",
      file: "test/test_nn.py",
    });
    expect(onFile.value).toEqual({ [pull]: ["101"] });
    expect(onFile.summary).toBe(`pull › ${BUILD} › default · shard 1 of 2`);
    expect(
      jobFilterOf(timeline, { kind: "build", workflow: PULL, build: BUILD })
        .value
    ).toEqual({ [pull]: ["101", "102"] });
    // A job without tests is not listed, and the key still says it is picked;
    // so it does before the jobs arrive.
    const onLint = jobFilterOf(timeline, { kind: "job", jobId: "103" });
    expect(onLint.value).toEqual({ [pull]: [] });
    expect(onLint.summary).toBe("pull › lintrunner / linux-job");
    expect(
      jobFilterOf(undefined, { kind: "job", jobId: "101" }).summary
    ).not.toBe("");
  });

  describe("of a workflow the commit ran more than once", () => {
    const TRUNK = ".github/workflows/trunk.yml";
    const at = (time: string) => `2026-11-14T${time}.000Z`;
    const job = (
      id: string,
      name: string,
      workflow: string,
      run: [id: string, attempt: number],
      overrides: Parameters<typeof commitJob>[2] = {}
    ) =>
      commitJob(id, name, {
        ...overrides,
        workflow: {
          run_id: run[0],
          run_attempt: run[1],
          name: workflow,
          path: `.github/workflows/${workflow}.yml`,
          event: "push",
        },
      });
    const late = { created_at: at("08:00:00"), started_at: at("08:02:00") };
    const tests = {
      by_status: { ...noCounts(), passed: 1 },
      running: [],
      failing_attempts: { failed: 0, flaky: 0 },
    };
    // trunk's run 20 ran at 5:00 and again, as its attempt 2, at 8:00. Its
    // run 19 began half a minute before run 20 and was cancelled a minute
    // in. docs has jobs of its run's second attempt alone, and lint, too
    // small for rows of its own, ran twice.
    const timeline = buildTimeline(
      [
        job("201", "macos / build", "trunk", ["20", 1]),
        job("202", "macos / test (default, 1, 1, m1)", "trunk", ["20", 1]),
        job("203", "macos / build", "trunk", ["20", 2], {
          ...late,
          completed_at: at("09:00:00"),
        }),
        job("204", "macos / test (default, 1, 1, m1)", "trunk", ["20", 2], {
          ...late,
          completed_at: at("09:00:00"),
        }),
        job("205", "macos / build", "trunk", ["19", 1], {
          created_at: at("04:59:30"),
          started_at: at("05:00:00"),
          completed_at: at("05:01:00"),
          conclusion: "cancelled",
        }),
        job("206", "build", "docs", ["22", 2]),
        job("207", "quick-checks", "lint", ["23", 1], {
          completed_at: at("05:02:20"),
        }),
        job("208", "quick-checks", "lint", ["24", 1], {
          ...late,
          completed_at: at("08:02:20"),
        }),
      ],
      [
        { job_id: "202", ...tests },
        { job_id: "204", ...tests },
      ],
      NOW
    );
    const second = { workflow: TRUNK, runId: "20", attempt: 2 };

    test("each run and attempt has a row, the workflow's rows together and a badge on all but the first", () => {
      // Of two runs begun within two minutes the longer is first, as of any
      // two rows.
      expect(
        timeline.root.children.map((row) => [
          row.name,
          row.mark,
          row.jobs.length,
        ])
      ).toEqual([
        ["trunk", undefined, 2],
        ["trunk", "attempt 2", 2],
        ["trunk", "run 2", 1],
        ["docs", undefined, 1],
        ["1 smaller workflow", undefined, 2],
      ]);
      expect(rowsUnder(timeline.nodes.get("small")!).map(nodeLabel)).toEqual([
        "lint",
        "lint · run 2",
      ]);
      // The title and the Job filter call a row by its badge too.
      expect(
        trailOf(timeline, { kind: "build", ...second, build: "macos" }).map(
          ({ label }) => label
        )
      ).toEqual(["trunk · attempt 2", "macos"]);
      expect(
        jobFilterOf(timeline, null).sections.map(({ title, options }) => [
          title,
          options.map(({ value }) => value),
        ])
      ).toEqual([
        ["trunk", ["202"]],
        ["trunk · attempt 2", ["204"]],
      ]);
    });

    test("a pick names its run where the workflow has another, and its attempt where the run has", () => {
      expect(timeline.root.children.slice(0, 4).map(pickOfNode)).toEqual([
        { kind: "workflow", workflow: TRUNK, runId: "20", attempt: 1 },
        { kind: "workflow", ...second },
        { kind: "workflow", workflow: TRUNK, runId: "19" },
        { kind: "workflow", workflow: ".github/workflows/docs.yml" },
      ]);
      const jobsOf = (pick: TimelinePick) =>
        nodeOfPick(timeline, pick)?.jobs.map(({ job: { id } }) => id);
      // A pick with no run is of the first run, with no attempt of the
      // run's first.
      expect(jobsOf({ kind: "workflow", workflow: TRUNK })).toEqual([
        "201",
        "202",
      ]);
      expect(jobsOf({ kind: "workflow", workflow: TRUNK, attempt: 2 })).toEqual(
        ["203", "204"]
      );
      expect(
        jobsOf({ kind: "workflow", workflow: TRUNK, runId: "19" })
      ).toEqual(["205"]);
      expect(
        jobsOf({ kind: "workflow", workflow: TRUNK, runId: "22" })
      ).toBeUndefined();
      // A build is its row's: the re-run's build holds the re-run's jobs.
      const build: TimelinePick = { kind: "build", ...second, build: "macos" };
      expect(jobsOf(build)).toEqual(["203", "204"]);
      expect(pickOfNode(nodeOfPick(timeline, build)!)).toEqual(build);
      expect(pickAbove(timeline, build)).toEqual({
        kind: "workflow",
        ...second,
      });
      expect(pickKey(build)).not.toBe(pickKey({ ...build, attempt: 1 }));
    });

    test("a workflow with more than eight runs keeps one row", () => {
      const rows = (runs: number) =>
        buildTimeline(
          Array.from({ length: runs }, (_, index) =>
            job(`${300 + index}`, "advise", "advisor", [`${40 + index}`, 1])
          ),
          [],
          NOW
        ).root.children;
      expect(rows(8).map((row) => row.mark)).toEqual([
        undefined,
        ...[2, 3, 4, 5, 6, 7, 8].map((run) => `run ${run}`),
      ]);
      const [only, ...others] = rows(9);
      expect([others.length, only.jobs.length, only.mark]).toEqual([
        0,
        9,
        undefined,
      ]);
      expect(pickOfNode(only)).toEqual({
        kind: "workflow",
        workflow: ".github/workflows/advisor.yml",
      });
    });
  });

  test("the clock closes in on an open job, and on its open file", () => {
    const job = timeline.nodes.get("job:101")!.job!;
    expect(viewOf(timeline, null, null)).toEqual({
      start: timeline.start,
      end: timeline.end,
    });
    const onJob = viewOf(timeline, job, null);
    expect(onJob.start).toBeLessThan(job.created);
    expect(onJob.end).toBeGreaterThan(job.ended);
    // A file of a few seconds still gets twenty seconds of clock.
    const onFile = viewOf(timeline, job, { start: 100, end: 104 });
    expect(onFile.end - onFile.start).toBe(20);
  });

  test("says why a pick lists no tests", () => {
    expect(noTestsWords(timeline, { kind: "job", jobId: "100" })).toBe(
      "This job has no Test step, so it recorded no tests."
    );
    expect(noTestsWords(timeline, { kind: "job", jobId: "101" })).toBeNull();
    expect(
      noTestsWords(timeline, {
        kind: "workflow",
        workflow: ".github/workflows/lint.yml",
      })
    ).toBe("These jobs recorded no tests.");
    expect(noTestsWords(timeline, null)).toBeNull();
  });

  test("the jobs before their tests are the same rows on the same clock, and say nothing of the tests", () => {
    const early = buildTimeline(COMMIT_JOBS, undefined, NOW);
    expect([early.testsPending, timeline.testsPending]).toEqual([true, false]);
    // Every row, the rows under it in their order, and what its jobs alone
    // say: running time, queue, and the jobs GitHub failed.
    const rowsOf = (drawn: Timeline) =>
      [...drawn.nodes.values()].map(({ id, children, totals }) => [
        id,
        children.map((child) => child.id),
        totals.run,
        totals.queue,
        totals.failed,
      ]);
    expect(rowsOf(early)).toEqual(rowsOf(timeline));
    expect([early.start, early.end]).toEqual([timeline.start, timeline.end]);
    // A job that passed with a failed test is failed once its tests are in.
    const passed = [commitJob("5", `${BUILD} / test (default, 1, 1, x)`)];
    const failedTest = {
      job_id: "5",
      by_status: { ...noCounts(), failed: 1 },
      running: [],
      failing_attempts: { failed: 0, flaky: 0 },
    };
    expect(
      [undefined, [failedTest]].map(
        (tests) => buildTimeline(passed, tests, NOW).root.totals.failed
      )
    ).toEqual([0, 1]);
    // Of the tests it says nothing yet: the Job filter offers no job and
    // still names the pick, and no job that ran is said to have none.
    const shard = { kind: "job", jobId: "101" } as const;
    expect(jobFilterOf(early, shard)).toMatchObject({
      sections: [],
      summary: `pull › ${BUILD} › default · shard 1 of 2`,
    });
    for (const pick of [
      { kind: "job", jobId: "100" },
      { kind: "workflow", workflow: ".github/workflows/lint.yml" },
    ] as const) {
      expect(noTestsWords(early, pick)).toBeNull();
    }
    // A job that did not run is known to have none.
    expect(
      noTestsWords(
        buildTimeline(
          [commitJob("2", "build", { conclusion: "skipped" })],
          undefined,
          NOW
        ),
        { kind: "job", jobId: "2" }
      )
    ).toBe("This job was skipped, so it ran no tests.");
  });
});
