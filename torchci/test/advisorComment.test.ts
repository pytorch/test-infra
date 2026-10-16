import { DispatchMark } from "lib/advisor/advisorBadge";
import { buildAdvisorVerdictLines } from "lib/advisor/advisorComment";
import { AdvisorVerdictRow } from "lib/advisorVerdictUtils";
import { RecentWorkflowsData } from "lib/types";

const HEAD_SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const JOB_NAME = "pull / linux-jammy-py3.10-gcc11 / test";
const NEWER = "2026-08-28 12:05:00.000";
const OLDER = "2026-08-28 11:55:00.000";

function job(
  overrides: Partial<RecentWorkflowsData> = {}
): RecentWorkflowsData {
  return {
    id: 1,
    name: JOB_NAME,
    ...overrides,
  } as unknown as RecentWorkflowsData;
}

function row(overrides: Partial<AdvisorVerdictRow> = {}): AdvisorVerdictRow {
  return {
    sha: HEAD_SHA,
    signal_key: `dr_ci_${JOB_NAME}`,
    verdict: "not_related",
    confidence: 0.95,
    summary: "unrelated to this PR",
    timestamp: NEWER,
    ...overrides,
  } as unknown as AdvisorVerdictRow;
}

async function lines(
  rows: AdvisorVerdictRow[],
  jobs: RecentWorkflowsData[] = [job()],
  dispatches: Map<string, DispatchMark> = new Map()
): Promise<Map<number, string>> {
  return buildAdvisorVerdictLines(
    "https://hud.pytorch.org",
    "pytorch",
    "pytorch",
    123,
    HEAD_SHA,
    jobs,
    rows,
    dispatches
  );
}

describe("buildAdvisorVerdictLines", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.DRCI_ADVISOR_COMMENT_ENABLED;
    process.env.DRCI_ADVISOR_COMMENT_ENABLED = "true";
  });
  afterEach(() => {
    if (saved === undefined) {
      delete process.env.DRCI_ADVISOR_COMMENT_ENABLED;
    } else {
      process.env.DRCI_ADVISOR_COMMENT_ENABLED = saved;
    }
  });

  test("renders the verdict badge for this head", async () => {
    expect((await lines([row()])).get(1)).toContain("not related");
  });

  test("the flag being off renders nothing", async () => {
    process.env.DRCI_ADVISOR_COMMENT_ENABLED = "false";
    expect(await lines([row()])).toEqual(new Map());
  });

  test("a verdict for a different head is not rendered", async () => {
    expect(await lines([row({ sha: OTHER_SHA })])).toEqual(new Map());
  });

  test("the newest verdict wins over an older one", async () => {
    const rendered = await lines([
      row({ verdict: "not_related", timestamp: OLDER }),
      row({ verdict: "related", timestamp: NEWER }),
    ]);
    expect(rendered.get(1)).toContain("related");
    expect(rendered.get(1)).not.toContain("not related");
  });

  // The reason the badge and the suppression gate now share one resolver: an
  // answer that arrived and is unusable must not render as a confident badge on
  // a job the gate keeps blocking.
  test("verdicts tied at the newest timestamp that disagree render no badge", async () => {
    expect(
      await lines([
        row({ verdict: "not_related", timestamp: NEWER }),
        row({ verdict: "related", timestamp: NEWER }),
      ])
    ).toEqual(new Map());
  });

  test("a row keyed to a different job is not rendered on this one", async () => {
    expect(
      await lines([row({ signal_key: "dr_ci_pull / some other job / test" })])
    ).toEqual(new Map());
  });

  test("tied agreeing verdicts render the least confident row whole", async () => {
    const rendered = await lines([
      row({ confidence: 0.95, timestamp: NEWER, summary: "high-conf summary" }),
      row({ confidence: 0.5, timestamp: NEWER, summary: "low-conf summary" }),
    ]);
    // 0.5 is below the badge scale's high bucket, so the label is hedged --
    // and the summary must come from that same row, not the other one.
    expect(rendered.get(1)).toContain("not related (uncertain)");
    expect(rendered.get(1)).toContain("low-conf summary");
    expect(rendered.get(1)).not.toContain("high-conf summary");
  });

  // A rerun at the same commit finished after the only dispatch and verdict.
  test("a verdict that does not cover the job's run is not rendered as one", async () => {
    const rendered = await lines(
      [row({ timestamp: NEWER })],
      [job({ completed_at: "2026-08-28 12:10:00" })],
      new Map([
        [
          `dr_ci_${JOB_NAME}`,
          { state: "dispatched", version: "2026-08-28 11:50:00.000" },
        ],
      ])
    );
    expect(rendered.get(1)).toContain('alt="AI verdict: pending"');
    expect(rendered.get(1)).not.toContain("<details>");
  });

  test("a verdict answering a dispatch made after the run renders", async () => {
    const rendered = await lines(
      [row({ timestamp: NEWER })],
      [job({ completed_at: "2026-08-28 11:50:00" })],
      new Map([
        [
          `dr_ci_${JOB_NAME}`,
          { state: "dispatched", version: "2026-08-28 12:00:00.000" },
        ],
      ])
    );
    expect(rendered.get(1)).toContain('alt="AI verdict: not related"');
  });
});
