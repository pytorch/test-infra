import { buildDemotionStatuses } from "../lib/crcr/demotionStatus";
import { L3SummaryRow } from "../lib/crcr/l3Readiness";

function summary(overrides: Partial<L3SummaryRow> = {}): L3SummaryRow {
  return {
    repo: "vendor/backend",
    successes: 100,
    timed_out: 0,
    total_jobs: 100,
    pass_rate: 1.0,
    avg_queue_time_s: 60,
    max_exec_time_s: 3600,
    overrun_rate: 0,
    median_e2e_time_s: 3600,
    timeout_rate: 0,
    ...overrides,
  };
}

// Fails the pass-rate criterion (< 90%).
const VIOLATING = { pass_rate: 0.5, successes: 50 };

function map(
  overrides: Partial<L3SummaryRow> | null,
  repo = "vendor/backend"
): Map<string, L3SummaryRow> {
  const m = new Map<string, L3SummaryRow>();
  if (overrides) m.set(repo, summary({ repo, ...overrides }));
  return m;
}

const status = (overrides: Partial<L3SummaryRow> | null) =>
  buildDemotionStatuses(["vendor/backend"], map(overrides))[0];
const listed = (overrides: Partial<L3SummaryRow>) =>
  status(overrides).onTemporaryDemotion;

describe("buildDemotionStatuses", () => {
  it("leaves a healthy repo off the list", () => {
    expect(listed({})).toBe(false);
  });

  it("lists a repo failing any single demotion criterion", () => {
    // RFC-0050: "Demotion is triggered when any of the following conditions
    // are observed" -- one failing criterion is enough.
    expect(listed({ pass_rate: 0.5, successes: 50 })).toBe(true);
    expect(listed({ timeout_rate: 0.05, timed_out: 5 })).toBe(true);
    expect(listed({ median_e2e_time_s: 4 * 3600 })).toBe(true);
  });

  it("does not list a repo just for one unjudged metric", () => {
    // It has jobs, only the e2e time is null -- unjudged, not failing.
    const s = status({ median_e2e_time_s: null });
    expect(s.onTemporaryDemotion).toBe(false);
    expect(s.noData).toBe(false);
  });

  it("ignores a failure that is only a promotion criterion", () => {
    // Overrun rate gates promotion but is not a demotion trigger.
    expect(listed({ overrun_rate: 0.5 })).toBe(false);
  });

  it("reports which criteria are triggering", () => {
    const s = status({ timeout_rate: 0.05, timed_out: 5 });
    expect(s.noData).toBe(false);
    expect(s.rows.filter((r) => r.verdict === false).map((r) => r.key)).toEqual(
      ["timeoutRate"]
    );
  });

  describe("repos with no jobs in the window", () => {
    it("lists an L3 repo that has no summary row at all", () => {
      // Silence: the repo is in the allowlist but reported nothing.
      const s = status(null);
      expect(s.onTemporaryDemotion).toBe(true);
      expect(s.noData).toBe(true);
    });

    it("does not flag anything while the summary is unavailable", () => {
      // null = still loading or the query failed: a missing row is unknown,
      // and treating it as silence would list every L3 repo.
      const [s] = buildDemotionStatuses(["vendor/backend"], null);
      expect(s.onTemporaryDemotion).toBe(false);
      expect(s.noData).toBe(false);
    });

    it("only considers the repos it was given", () => {
      // Rows for repos outside the list (e.g. not L3) are ignored.
      const statuses = buildDemotionStatuses(
        ["vendor/a"],
        new Map([["vendor/b", summary({ repo: "vendor/b", ...VIOLATING })]])
      );
      expect(statuses.map((s) => s.repo)).toEqual(["vendor/a"]);
      expect(statuses[0].noData).toBe(true);
    });
  });

  // The RFC writes the demotion triggers as "pass rate <= 90%" and "e2e > 3h",
  // but both share a single threshold with the promotion criteria (promotion
  // wants ">= 90%" and "< 3h"), so one boolean has to serve both directions.
  // These pin where that boolean actually flips, so any future change to the
  // comparison is a deliberate one rather than a silent shift.
  describe("criterion boundaries", () => {
    it("pass rate: 90% exactly does not fail, just below does", () => {
      expect(listed({ pass_rate: 0.9 })).toBe(false);
      expect(listed({ pass_rate: 0.8999 })).toBe(true);
    });

    it("e2e time: 3h exactly fails, just under does not", () => {
      expect(listed({ median_e2e_time_s: 3 * 3600 })).toBe(true);
      expect(listed({ median_e2e_time_s: 3 * 3600 - 1 })).toBe(false);
    });

    it("timeout rate: 1% exactly fails, just under does not", () => {
      expect(listed({ timeout_rate: 0.01, timed_out: 1 })).toBe(true);
      expect(listed({ timeout_rate: 0.0099 })).toBe(false);
    });
  });

  it("tracks each repo separately", () => {
    const repos = new Map<string, L3SummaryRow>([
      ["vendor/a", summary({ repo: "vendor/a", ...VIOLATING })],
      ["vendor/b", summary({ repo: "vendor/b" })],
    ]);
    const byRepo = new Map(
      buildDemotionStatuses(["vendor/a", "vendor/b"], repos).map((s) => [
        s.repo,
        s.onTemporaryDemotion,
      ])
    );
    expect(byRepo.get("vendor/a")).toBe(true);
    expect(byRepo.get("vendor/b")).toBe(false);
  });
});
