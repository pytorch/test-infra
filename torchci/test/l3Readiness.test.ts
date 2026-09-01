import {
  buildCriteriaRows,
  L3SummaryRow,
  RepoTenure,
  summarizeReadiness,
  TenureInfo,
  tenureInfoFromRow,
} from "../lib/crcr/l3Readiness";
import { evaluateL3Threshold, L3_THRESHOLDS } from "../lib/crcr/l3Thresholds";

function repoTenure(overrides: Partial<RepoTenure>): RepoTenure {
  return {
    current_level: "L2",
    level_since: "2026-01-01T00:00:00Z",
    first_seen: "2026-01-01T00:00:00Z",
    last_seen: "2026-08-30T00:00:00Z",
    ...overrides,
  };
}

describe("tenureInfoFromRow", () => {
  it("returns null when there is no row", () => {
    expect(tenureInfoFromRow(undefined)).toBeNull();
    expect(tenureInfoFromRow(null)).toBeNull();
  });

  it("returns null when the repo has no current level", () => {
    expect(tenureInfoFromRow(repoTenure({ current_level: "" }))).toBeNull();
  });

  it("carries the current level and computes tenure days from level_since", () => {
    const tenure = tenureInfoFromRow(
      repoTenure({
        current_level: "L2",
        level_since: new Date(
          Date.now() - 60 * 24 * 60 * 60 * 1000
        ).toISOString(),
      })
    );
    expect(tenure?.currentLevel).toBe("L2");
    expect(tenure?.tenureDays).toBeCloseTo(60, 0);
  });
});

describe("evaluateL3Threshold", () => {
  it("returns null when there is no data", () => {
    expect(evaluateL3Threshold(L3_THRESHOLDS.passRate, null)).toBeNull();
    expect(evaluateL3Threshold(L3_THRESHOLDS.passRate, undefined)).toBeNull();
  });

  it("passes a repo at 93% pass rate", () => {
    // A prior version of the stat-card coloring flagged 93% pass rate as a
    // warning even though the target (>90%) says it passes. The shared
    // threshold must not repeat that drift.
    expect(evaluateL3Threshold(L3_THRESHOLDS.passRate, 0.93)).toBe(true);
    expect(evaluateL3Threshold(L3_THRESHOLDS.passRate, 0.89)).toBe(false);
  });

  it("evaluates a 'below' criterion correctly at the boundary", () => {
    const t = L3_THRESHOLDS.timeoutRate; // < 1%
    expect(evaluateL3Threshold(t, 0.009)).toBe(true);
    expect(evaluateL3Threshold(t, 0.01)).toBe(false);
    expect(evaluateL3Threshold(t, 0.011)).toBe(false);
  });
});

function summaryRow(overrides: Partial<L3SummaryRow>): L3SummaryRow {
  return {
    repo: "pytorch/example",
    successes: 100,
    timed_out: 0,
    total_jobs: 100,
    pass_rate: 1.0,
    avg_queue_time_s: 60,
    max_exec_time_s: 3600,
    median_e2e_time_s: 3600,
    timeout_rate: 0,
    ...overrides,
  };
}

const goodTenure: TenureInfo = {
  currentLevel: "L2",
  tenureDays: 60,
};

describe("buildCriteriaRows / summarizeReadiness", () => {
  it("has one row per L3 threshold, in a stable order — six criteria, not seven", () => {
    // L3 Promotion's prerequisites list tenure + five metrics.
    const rows = buildCriteriaRows(summaryRow({}), null);
    expect(rows.map((r) => r.key)).toEqual([
      "tenureAtL2Days",
      "e2eTimeS",
      "maxExecTimeS",
      "avgQueueTimeS",
      "timeoutRate",
      "passRate",
    ]);
  });

  it("marks tenure as unjudged (not failed) when tenure is null — e.g. a repo crcr_repo_tenure has no rows for", () => {
    const rows = buildCriteriaRows(summaryRow({}), null);
    const tenureRow = rows.find((r) => r.key === "tenureAtL2Days");
    expect(tenureRow?.verdict).toBeNull();
  });

  it("is ready only when every criterion is judged and met", () => {
    const goodSummary = summaryRow({
      avg_queue_time_s: 60,
      max_exec_time_s: 1000,
      median_e2e_time_s: 1000,
      timeout_rate: 0,
      pass_rate: 1.0,
    });

    const readyRows = buildCriteriaRows(goodSummary, goodTenure);
    expect(summarizeReadiness(readyRows).ready).toBe(true);

    const notReadyRows = buildCriteriaRows(
      summaryRow({ pass_rate: 0.5 }),
      goodTenure
    );
    const notReady = summarizeReadiness(notReadyRows);
    expect(notReady.ready).toBe(false);
    expect(notReady.metCount).toBe(notReady.totalCount - 1);
  });

  it("is never ready while tenure is null, even with a perfect summary", () => {
    // A repo with no tenure data at all (crcr_repo_tenure returns no row)
    // should never read "Ready" outright — only "N/M criteria met".
    const rows = buildCriteriaRows(summaryRow({}), null);
    const result = summarizeReadiness(rows);
    expect(result.judgedCount).toBe(5);
    expect(result.metCount).toBe(5);
    expect(result.ready).toBe(false);
  });

  it("is not ready when data is missing entirely", () => {
    const rows = buildCriteriaRows(null, null);
    const result = summarizeReadiness(rows);
    expect(result.judgedCount).toBe(0);
    expect(result.ready).toBe(false);
  });
});
