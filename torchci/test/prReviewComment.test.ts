import * as clickhouse from "lib/clickhouse";
import { PR_REVIEW_PENDING_ALT_ATTR } from "lib/greenlight/greenlightSweep";
import {
  buildPrReviewSections,
  latestPrReviewRequests,
  PR_REVIEW_REPOS,
  prReviewSectionForLabels,
} from "lib/prReview/prReviewComment";
import * as prReviewRender from "lib/prReview/prReviewRender";
import { getDummyJob } from "./utils";

const NOW = new Date("2026-11-10T19:00:00Z");

const ROW = {
  pr_number: 196508,
  head_sha: "183b1a21182c55bbb7e833aed6f6af2cd279ef6f",
  status: "succeeded",
  verdict: "ready_for_human_review",
  summary: "Looks coherent.",
  findings_count: 0,
  findings_json: "",
  review_run_id: 36866468841,
  timestamp: "2026-10-01 19:50:00.000",
};
const OTHER = { ...ROW, pr_number: 199010, verdict: "changes_requested" };

const CAPTURE = getDummyJob({
  workflowId: 42875235669,
  id: 130036655409,
  workflowPath: ".github/workflows/hardened-pr-review.yml",
  workflowEvent: "pull_request_target",
  jobName: "capture",
  name: "Hardened PR Review / capture",
  conclusion: "success",
  completed_at: "2026-11-10 18:26:48.000000000",
  html_url:
    "https://github.com/pytorch/pytorch/actions/runs/42875235669/job/130036655409",
  head_sha: ROW.head_sha,
  pr_number: ROW.pr_number,
});
const HEADS = new Map([[ROW.pr_number, ROW.head_sha]]);

async function build(captures = [CAPTURE]) {
  return buildPrReviewSections("pytorch", "pytorch", HEADS, captures);
}

describe("buildPrReviewSections", () => {
  let queryClickhouseSaved: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    queryClickhouseSaved = jest
      .spyOn(clickhouse, "queryClickhouseSaved")
      .mockResolvedValue([]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it("issues no query for a repo that is not enabled", async () => {
    const sections = await buildPrReviewSections(
      "pytorch",
      "vision",
      new Map([[ROW.pr_number, ROW.head_sha]])
    );
    expect(sections.size).toBe(0);
    expect(queryClickhouseSaved).not.toHaveBeenCalled();
  });

  it("holds every repo entry in lower case", () => {
    for (const name of PR_REVIEW_REPOS) {
      expect(name).toBe(name.toLowerCase());
    }
  });

  it("issues no query when no PRs were passed", async () => {
    const sections = await buildPrReviewSections(
      "pytorch",
      "pytorch",
      new Map()
    );
    expect(sections.size).toBe(0);
    expect(queryClickhouseSaved).not.toHaveBeenCalled();
  });

  it("batches the sweep into one query and keys sections by PR", async () => {
    queryClickhouseSaved.mockResolvedValue([ROW]);
    const sections = await buildPrReviewSections(
      "PyTorch",
      "PyTorch",
      new Map([
        [ROW.pr_number, ROW.head_sha],
        [123, "abc"],
      ])
    );
    expect(queryClickhouseSaved).toHaveBeenCalledTimes(1);
    expect(queryClickhouseSaved).toHaveBeenCalledWith(
      "pr_review_verdicts_for_prs",
      { repo: "pytorch/pytorch", prNumbers: [ROW.pr_number, 123] }
    );
    expect(Array.from(sections.keys())).toEqual([ROW.pr_number]);
    expect(sections.get(ROW.pr_number)?.body).toContain(
      "Ready for human review"
    );
  });

  it("keeps other PRs' sections when one row's render throws", async () => {
    queryClickhouseSaved.mockResolvedValue([ROW, OTHER]);
    const real = prReviewRender.renderPrReviewSection;
    jest
      .spyOn(prReviewRender, "renderPrReviewSection")
      .mockImplementation((row, ...rest) => {
        if (row.pr_number === ROW.pr_number) {
          throw new Error("boom");
        }
        return real(row, ...rest);
      });
    const errors = jest.spyOn(console, "error").mockImplementation(() => {});
    const sections = await buildPrReviewSections(
      "pytorch",
      "pytorch",
      new Map([
        [ROW.pr_number, ROW.head_sha],
        [OTHER.pr_number, OTHER.head_sha],
      ])
    );
    expect(Array.from(sections.keys())).toEqual([OTHER.pr_number]);
    expect(errors).toHaveBeenCalled();
  });

  it("keeps a captured request in the sweep until its missing status times out", async () => {
    const pending = (await build()).get(ROW.pr_number)!;
    expect(pending.missingRequest).toBe(true);
    expect(pending.body).toContain("Review pending");
    expect(pending.body).toContain(PR_REVIEW_PENDING_ALT_ATTR);
    expect(pending.body).toContain("Requested commit:");
    expect(pending.body).not.toContain("Reviewed commit:");
    expect(pending.body).toContain(
      "[Review request](https://github.com/pytorch/pytorch/actions/runs/42875235669)"
    );

    jest.setSystemTime(new Date("2026-11-10T20:26:48Z"));
    const stale = (await build()).get(ROW.pr_number)!;
    expect(stale.body).toContain("Review did not complete");
    expect(stale.body).toContain("`@pytorchbot review`");
    expect(stale.body).not.toContain(PR_REVIEW_PENDING_ALT_ATTR);
  });

  it.each(["started", "succeeded"])(
    "replaces the fallback when a %s row arrives",
    async (status) => {
      queryClickhouseSaved.mockResolvedValue([
        {
          ...ROW,
          status,
          trigger_run_id: String(CAPTURE.workflowId),
          started_at_ms: String(Date.parse("2026-11-10T18:27:30Z")),
          timestamp: "2026-11-10 18:28:00.000",
        },
      ]);
      const section = (await build()).get(ROW.pr_number)!;
      expect(section.missingRequest).toBeUndefined();
      expect(section.body).toContain(
        status === "started" ? "Review in progress" : "Ready for human review"
      );
    }
  );

  it("does not let an older verdict hide a new request on the same head", async () => {
    queryClickhouseSaved.mockResolvedValue([
      {
        ...ROW,
        trigger_run_id: CAPTURE.workflowId - 1,
        // An old review may finish after the new capture.
        started_at_ms: NOW.getTime(),
        timestamp: NOW.toISOString(),
      },
    ]);
    expect((await build()).get(ROW.pr_number)?.missingRequest).toBe(true);
  });

  it("recognizes a rerun of the capture even though its run id is unchanged", async () => {
    queryClickhouseSaved.mockResolvedValue([
      {
        ...ROW,
        trigger_run_id: CAPTURE.workflowId,
        started_at_ms: Date.parse("2026-11-10T18:00:00Z"),
        timestamp: NOW.toISOString(),
      },
    ]);
    expect((await build()).get(ROW.pr_number)?.missingRequest).toBe(true);
  });

  it("does not accept an older terminal-only review that finishes after the new capture", async () => {
    const terminalAt = Date.parse("2026-11-10T18:40:00Z");
    const durationMs = 30 * 60 * 1000;
    queryClickhouseSaved.mockResolvedValue([
      {
        ...ROW,
        trigger_run_id: CAPTURE.workflowId,
        // The saved query estimates the start when only a terminal row arrived.
        started_at_ms: terminalAt - durationMs,
        timestamp: new Date(terminalAt).toISOString(),
      },
    ]);
    expect((await build()).get(ROW.pr_number)?.missingRequest).toBe(true);
  });

  it("preserves a newer review when the capture mirror lags", async () => {
    queryClickhouseSaved.mockResolvedValue([
      {
        ...ROW,
        trigger_run_id: CAPTURE.workflowId + 1,
        started_at_ms: Date.parse("2026-11-10T18:27:30Z"),
      },
    ]);
    expect((await build()).get(ROW.pr_number)?.missingRequest).toBeUndefined();
  });

  it("does not let a larger run id hide a rerun of an older capture", async () => {
    queryClickhouseSaved.mockResolvedValue([
      {
        ...ROW,
        trigger_run_id: CAPTURE.workflowId + 1,
        started_at_ms: Date.parse("2026-11-10T18:00:00Z"),
      },
    ]);
    expect((await build()).get(ROW.pr_number)?.missingRequest).toBe(true);
  });

  it("does not confuse a previous head's verdict with the current request", async () => {
    queryClickhouseSaved.mockResolvedValue([
      {
        ...ROW,
        head_sha: "old-head",
        trigger_run_id: CAPTURE.workflowId + 1,
      },
    ]);
    expect((await build()).get(ROW.pr_number)?.missingRequest).toBe(true);
  });

  it("does not infer a missing review from a telemetry read failure", async () => {
    queryClickhouseSaved.mockRejectedValue(new Error("database unavailable"));
    await expect(build()).rejects.toThrow("database unavailable");
  });

  it.each([
    [],
    ["triaged"],
    ["in progress", "ready for review"],
    ["in progress", "no automated review"],
  ])("suppresses missing-review notices for labels %j", async (...labels) => {
    const section = (await build()).get(ROW.pr_number)!;
    expect(prReviewSectionForLabels(section, labels)).toBe("");
    expect(prReviewSectionForLabels(section, ["in progress"])).toBe(
      section.body
    );
  });

  it("preserves existing verdicts outside the in-progress stage", async () => {
    queryClickhouseSaved.mockResolvedValue([ROW]);
    const section = (await build([])).get(ROW.pr_number)!;
    expect(prReviewSectionForLabels(section, ["ready for review"])).toContain(
      "Ready for human review"
    );
  });
});

describe("latestPrReviewRequests", () => {
  it.each([
    { workflowPath: ".github/workflows/spoof.yml" },
    { workflowEvent: "pull_request" },
    { workflowPath: undefined, workflowEvent: undefined },
    { jobName: "something-else" },
    { conclusion: "skipped" },
    { conclusion: "cancelled" },
    { conclusion: "failure" },
    { conclusion: null },
    { prDraft: true },
    { head_sha: "old-head" },
    { workflowId: 0 },
    {
      html_url:
        "https://github.com/attacker/fork/actions/runs/42875235669/job/1",
    },
    { completed_at: "invalid" },
  ])(
    "ignores a capture without eligible, trusted evidence: %j",
    (overrides) => {
      expect(
        latestPrReviewRequests("pytorch/pytorch", HEADS, [
          { ...CAPTURE, ...overrides } as typeof CAPTURE,
        ]).size
      ).toBe(0);
    }
  );

  it("keeps the latest successful request despite newer skipped runs and duplicate rows", () => {
    const newer = {
      ...CAPTURE,
      workflowId: CAPTURE.workflowId + 1,
      conclusion: "skipped",
    };
    const rerun = { ...CAPTURE, completed_at: "2026-11-11 18:26:48.000000000" };
    const requests = latestPrReviewRequests("pytorch/pytorch", HEADS, [
      rerun,
      newer,
      CAPTURE,
      CAPTURE,
    ]);
    expect(requests.get(ROW.pr_number)?.completedAt).toBe(rerun.completed_at);
  });
});
