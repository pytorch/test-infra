import {
  buildBoard,
  buildIndex,
  currentRc,
  effectiveLinks,
  linksFromRows,
  nextMilestone,
} from "lib/api/releases/board";
import { resolveRelease } from "lib/api/releases/config";
import { ReleaseBoardSchema, ReleaseIndexSchema } from "lib/api/releases/types";
import { MINOR, row, SHARED, step } from "./fixtures";

const NOW = new Date("2026-11-20T12:00:00Z");

function stepsOf(board: ReturnType<typeof buildBoard>) {
  return Object.fromEntries(
    board.phases.flatMap((p) => p.steps).map((s) => [s.id, s])
  );
}

describe("currentRc", () => {
  test("is the newest release candidate, by number", () => {
    expect(currentRc([])).toBeNull();
    expect(currentRc([row({ step_id: "2.1", rc: "" })])).toBeNull();
    expect(
      currentRc([
        row({ step_id: "2.1", rc: "rc9" }),
        row({ step_id: "2.1", rc: "rc10" }),
        row({ step_id: "2.1", rc: "rc2" }),
      ])
    ).toBe("rc10");
  });
});

describe("nextMilestone", () => {
  test("is the earliest dated milestone that is today or later", () => {
    expect(nextMilestone(MINOR, NOW)).toEqual({
      name: "Branch cut",
      date: "2026-11-30",
    });
    expect(nextMilestone(MINOR, new Date("2026-11-30T23:00:00Z"))?.name).toBe(
      "Branch cut"
    );
    expect(nextMilestone(MINOR, new Date("2026-12-01T00:00:00Z"))?.name).toBe(
      "Final RC"
    );
    expect(nextMilestone(MINOR, new Date("2026-12-08T00:00:00Z"))?.name).toBe(
      "GA"
    );
    expect(nextMilestone(MINOR, new Date("2026-12-18T00:00:00Z"))).toBeNull();
    expect(
      nextMilestone(resolveRelease(SHARED, null, "2.15.1"), NOW)
    ).toBeNull();
  });
});

describe("buildBoard", () => {
  test("with no state, every step is to do and nothing is blocking", () => {
    const board = buildBoard(MINOR, [], NOW);
    expect(ReleaseBoardSchema.parse(board)).toEqual(board);
    expect(board).toMatchObject({
      version: "2.16.0",
      type: "minor",
      branch: "release/2.16",
      current_rc: null,
    });
    expect(board.stats).toEqual({
      done: 0,
      total: 4,
      blocking: 0,
      next_milestone: { name: "Branch cut", date: "2026-11-30" },
      last_checked: null,
    });
    for (const s of Object.values(stepsOf(board))) {
      expect(s).toMatchObject({
        status: "todo",
        blocking: false,
        evidence: null,
        last_checked: null,
      });
    }
    expect(board.phases.map((p) => [p.id, p.collapsed])).toEqual([
      [1, false],
      [2, false],
    ]);
  });

  test("shows each step's state, evidence and when it was checked", () => {
    const board = buildBoard(
      MINOR,
      [
        row({
          step_id: "1.2",
          status: "blocked",
          blocking: "1",
          evidence_text: "3 items outstanding",
          evidence_url: "https://github.com/pytorch/pytorch/milestone/71",
          last_checked: "2026-12-01 22:00:00.000",
        }),
      ],
      NOW
    );
    expect(stepsOf(board)["1.2"]).toMatchObject({
      status: "blocked",
      blocking: true,
      evidence: {
        text: "3 items outstanding",
        url: "https://github.com/pytorch/pytorch/milestone/71",
      },
      last_checked: "2026-12-01T22:00:00.000Z",
    });
    expect(board.stats.blocking).toBe(1);
    expect(board.stats.last_checked).toBe("2026-12-01T22:00:00.000Z");
  });

  test("a step that is done is never blocking, and an unknown status is to do", () => {
    const board = buildBoard(
      MINOR,
      [
        row({ step_id: "1.1", status: "done", blocking: 1 }),
        row({ step_id: "1.2", status: "weird" }),
      ],
      NOW
    );
    expect(stepsOf(board)["1.1"]).toMatchObject({
      status: "done",
      blocking: false,
    });
    expect(stepsOf(board)["1.2"].status).toBe("todo");
  });

  test("rows for steps the config does not have are ignored", () => {
    const board = buildBoard(
      MINOR,
      [row({ step_id: "9.9", status: "done" })],
      NOW
    );
    expect(board.stats).toMatchObject({ done: 0, total: 4 });
  });

  test("a step scoped to a release candidate shows the newest candidate's state", () => {
    const board = buildBoard(
      MINOR,
      [
        row({ step_id: "2.1", rc: "rc1", status: "done" }),
        row({
          step_id: "2.1",
          rc: "rc2",
          status: "in_progress",
          evidence_text: "building",
        }),
      ],
      NOW
    );
    expect(board.current_rc).toBe("rc2");
    expect(stepsOf(board)["2.1"]).toMatchObject({
      rc: "rc2",
      status: "in_progress",
      evidence: { text: "building", url: null },
    });
    // a step not scoped to a candidate has no rc
    expect(stepsOf(board)["1.2"].rc).toBeNull();
  });

  test("a new candidate starts a scoped step again at to do", () => {
    const board = buildBoard(
      MINOR,
      [
        row({ step_id: "2.1", rc: "rc1", status: "done" }),
        row({ step_id: "1.2", rc: "", status: "done" }),
        row({ step_id: "2.2", rc: "rc2", status: "todo" }),
      ],
      NOW
    );
    expect(board.current_rc).toBe("rc2");
    expect(stepsOf(board)["2.1"]).toMatchObject({ rc: "rc2", status: "todo" });
    expect(stepsOf(board)["1.2"].status).toBe("done");
  });

  test("a phase whose steps are all done is collapsed", () => {
    const board = buildBoard(
      MINOR,
      [
        row({ step_id: "1.1", status: "done" }),
        row({ step_id: "1.2", status: "done" }),
      ],
      NOW
    );
    expect(board.phases.map((p) => p.collapsed)).toEqual([true, false]);
  });

  test("works out due dates from the milestone dates", () => {
    const steps = stepsOf(buildBoard(MINOR, [], NOW));
    expect(steps["1.1"].due).toBe("2026-11-23"); // 7 days before the branch cut
    expect(steps["1.2"].due).toBeNull();
    const undated = stepsOf(
      buildBoard(resolveRelease(SHARED, null, "2.16.0"), [], NOW)
    );
    expect(undated["1.1"].due).toBeNull();
  });

  test("a step the portal cannot observe says what to check and where", () => {
    const withTracker = resolveRelease(
      SHARED,
      { release: "2.16.0", links: { tracker_issue: 7 } },
      "2.16.0"
    );
    const steps = stepsOf(buildBoard(withTracker, [], NOW));
    expect(steps["1.1"].manual).toEqual({
      what_to_check: "look",
      link: "https://x/2.16.0",
    });
    expect(steps["2.2"].manual).toEqual({
      what_to_check: "tracker",
      link: "https://github.com/pytorch/pytorch/issues/7",
    });
    expect(steps["1.2"].manual).toBeNull();
  });

  test("a link that depends on something that does not exist yet is null", () => {
    const steps = stepsOf(buildBoard(MINOR, [], NOW));
    expect(steps["2.2"].manual?.link).toBeNull();
  });

  test("the links are what the rows evidence, then the configured resources, then the artifacts page", () => {
    const board = buildBoard(
      MINOR,
      [
        row({
          step_id: "1.2",
          evidence_url: "https://github.com/pytorch/pytorch/milestone/71",
        }),
      ],
      NOW
    );
    expect(board.links).toEqual({
      tracker_issue: null,
      validation_issue: null,
      milestone: "https://github.com/pytorch/pytorch/milestone/71",
      wheels: "https://download.pytorch.org/whl/test/",
      docs: "https://docs.pytorch.org/docs/2.16/",
      artifacts: "/release/2.16.0/artifacts",
    });
  });

  test("the wheels link moves to the release channel once every step is done", () => {
    const rows = MINOR.steps.map((s) =>
      row({ step_id: s.id, status: "done", rc: s.rc_scoped ? "rc1" : "" })
    );
    const board = buildBoard(MINOR, rows, NOW);
    expect(board.links.wheels).toBe("https://download.pytorch.org/whl/");
  });

  test("a link set in the release file wins over what was found", () => {
    const config = resolveRelease(
      SHARED,
      {
        release: "2.16.0",
        links: {
          tracker_issue: 123,
          validation_issue: "https://github.com/pytorch/pytorch/issues/456",
          milestone: "not a link",
        },
      },
      "2.16.0"
    );
    const found = {
      milestone: {
        number: 71,
        title: "2.16.0",
        url: "https://github.com/pytorch/pytorch/milestone/71",
      },
      tracker_issue: { number: 1, title: "t", url: "https://found/1" },
      validation_issue: null,
    };
    const links = effectiveLinks(config, found);
    expect(links.tracker_issue).toMatchObject({
      number: 123,
      url: "https://github.com/pytorch/pytorch/issues/123",
    });
    expect(links.validation_issue).toMatchObject({
      number: 456,
      url: "https://github.com/pytorch/pytorch/issues/456",
    });
    expect(links.milestone).toEqual(found.milestone);
    expect(buildBoard(config, [], NOW).links.tracker_issue).toBe(
      "https://github.com/pytorch/pytorch/issues/123"
    );
  });
});

describe("the links found in the rows", () => {
  const issueStep = (id: string, issue: string, expect: string) =>
    step({
      id,
      check: {
        type: "github_issue_state",
        repo: "pytorch/pytorch",
        issue,
        expect,
      },
    });
  // 1.2 checks the milestone, 2.2 shows the tracker as a manual link
  const config = {
    ...MINOR,
    steps: [
      ...MINOR.steps,
      issueStep("1.6", "{tracker_issue}", "open"),
      issueStep("2.7", "{validation_issue}", "open"),
      issueStep("5.1", "{tracker_issue}", "closed"),
    ],
  };
  const GITHUB = "https://github.com/pytorch/pytorch";
  const rows = [
    row({ step_id: "1.2", evidence_url: `${GITHUB}/milestone/71` }),
    row({ step_id: "1.6", evidence_url: `${GITHUB}/issues/199813` }),
    row({ step_id: "2.7", evidence_url: `${GITHUB}/issues/201644` }),
  ];

  test("are the evidence of the steps that check them, found by what they check", () => {
    expect(linksFromRows(config, rows)).toEqual({
      milestone: { number: 71, title: "", url: `${GITHUB}/milestone/71` },
      tracker_issue: {
        number: 199813,
        title: "",
        url: `${GITHUB}/issues/199813`,
      },
      validation_issue: {
        number: 201644,
        title: "",
        url: `${GITHUB}/issues/201644`,
      },
    });
  });

  test("show on the board and fill the links of the manual steps", () => {
    const board = buildBoard(config, rows, NOW);
    expect(board.links).toMatchObject({
      milestone: `${GITHUB}/milestone/71`,
      tracker_issue: `${GITHUB}/issues/199813`,
      validation_issue: `${GITHUB}/issues/201644`,
    });
    expect(stepsOf(board)["2.2"].manual?.link).toBe(`${GITHUB}/issues/199813`);
  });

  test("are null until the collector has recorded them", () => {
    const board = buildBoard(config, [], NOW);
    expect(board.links).toMatchObject({
      milestone: null,
      tracker_issue: null,
      validation_issue: null,
    });
    expect(stepsOf(board)["2.2"].manual?.link).toBeNull();
  });

  test("ignore evidence that does not link to the right kind of object", () => {
    const found = linksFromRows(config, [
      // the closing step's evidence is the milestone, and the first step's is not a link
      row({ step_id: "1.6", evidence_url: "" }),
      row({ step_id: "5.1", evidence_url: `${GITHUB}/milestone/71` }),
      row({ step_id: "1.2", evidence_url: `${GITHUB}/issues/5` }),
      row({ step_id: "2.7", evidence_url: `${GITHUB}/issues/201644/` }),
    ]);
    expect(found).toEqual({
      milestone: null,
      tracker_issue: null,
      validation_issue: null,
    });
  });

  test("come from the first step with a link, and the release file wins", () => {
    const found = linksFromRows(config, [
      row({ step_id: "1.6", evidence_url: "" }),
      row({ step_id: "5.1", evidence_url: `${GITHUB}/issues/199813` }),
    ]);
    expect(found.tracker_issue?.number).toBe(199813);
    const set = { ...config, links: { ...config.links, tracker_issue: 5 } };
    expect(buildBoard(set, rows, NOW).links.tracker_issue).toBe(
      `${GITHUB}/issues/5`
    );
  });
});

describe("buildIndex", () => {
  const patch = resolveRelease(SHARED, { release: "2.15.1" }, "2.15.1");
  const older = resolveRelease(SHARED, null, "2.15.0");
  const all = (config: typeof MINOR, release: string) =>
    config.steps.map((s) =>
      row({
        release,
        step_id: s.id,
        status: "done",
        rc: s.rc_scoped ? "rc1" : "",
      })
    );

  const index = buildIndex(
    [
      { config: older, rows: all(older, "2.15.0") },
      {
        config: MINOR,
        rows: [
          row({ step_id: "1.1", status: "done" }),
          row({ step_id: "1.2", status: "blocked", blocking: 1 }),
        ],
      },
      {
        config: patch,
        rows: [
          row({ release: "2.15.1", step_id: "1.2", status: "in_progress" }),
        ],
      },
    ],
    NOW
  );

  test("matches the response schema and lists releases newest first", () => {
    expect(ReleaseIndexSchema.parse(index)).toEqual(index);
    expect(index.releases.map((r) => r.version)).toEqual([
      "2.16.0",
      "2.15.1",
      "2.15.0",
    ]);
    expect(index.pagination).toEqual({ next: null, previous: null });
  });

  test("says each release's progress, phase and status", () => {
    const byVersion = Object.fromEntries(
      index.releases.map((r) => [r.version, r])
    );
    expect(byVersion["2.16.0"]).toMatchObject({
      type: "minor",
      branch: "release/2.16",
      ga_date: "2026-12-17",
      ga_planned: true,
      progress: { done: 1, total: 4 },
      phase: "Preparation",
      status: "blocked",
    });
    expect(byVersion["2.15.1"]).toMatchObject({
      type: "patch",
      ga_date: null,
      progress: { done: 0, total: 3 },
      status: "in_progress",
    });
    expect(byVersion["2.15.0"]).toMatchObject({
      progress: { done: 4, total: 4 },
      phase: "Released",
      status: "done",
      ga_planned: false,
    });
  });

  test("the active releases are those not out, and there can be several", () => {
    expect(index.active.map((a) => a.version)).toEqual(["2.16.0", "2.15.1"]);
    expect(index.active[0]).toEqual({
      version: "2.16.0",
      phase: "Preparation",
      blocking: 1,
      next_milestone: { name: "Branch cut", date: "2026-11-30" },
    });
  });

  test("a release with no state yet is to do, in its first phase", () => {
    const fresh = buildIndex([{ config: MINOR, rows: [] }], NOW).releases[0];
    expect(fresh).toMatchObject({
      status: "todo",
      phase: "Preparation",
      progress: { done: 0, total: 4 },
    });
  });

  test("orders versions as numbers, not text", () => {
    const configs = ["2.9.0", "2.10.0", "2.2.1"].map((v) =>
      resolveRelease(SHARED, null, v)
    );
    const versions = buildIndex(
      configs.map((config) => ({ config, rows: [] })),
      NOW
    ).releases.map((r) => r.version);
    expect(versions).toEqual(["2.10.0", "2.9.0", "2.2.1"]);
  });
});
