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

// Fails the pass-rate criterion (<= 90%).
const VIOLATING = { pass_rate: 0.5, successes: 50 };

function map(
  overrides: Partial<L3SummaryRow> | null,
  repo = "vendor/backend"
): Map<string, L3SummaryRow> {
  const m = new Map<string, L3SummaryRow>();
  if (overrides) m.set(repo, summary({ repo, ...overrides }));
  return m;
}

describe("buildDemotionStatuses", () => {
  it("leaves a healthy repo off the list", () => {
    const [status] = buildDemotionStatuses(map({}));
    expect(status.onTemporaryDemotion).toBe(false);
  });

  it("lists a repo violating the demotion criteria", () => {
    const [status] = buildDemotionStatuses(map(VIOLATING));
    expect(status.onTemporaryDemotion).toBe(true);
  });

  it("ignores a failure that is only a promotion criterion", () => {
    // Overrun rate gates promotion but is not a demotion trigger.
    const [status] = buildDemotionStatuses(map({ overrun_rate: 0.5 }));
    expect(status.onTemporaryDemotion).toBe(false);
  });

  it("reports which criteria are triggering", () => {
    const [status] = buildDemotionStatuses(
      map({ timeout_rate: 0.05, timed_out: 5 })
    );
    expect(
      status.rows.filter((r) => r.verdict === false).map((r) => r.key)
    ).toEqual(["timeoutRate"]);
  });

  it("tracks each repo separately", () => {
    const repos = new Map<string, L3SummaryRow>([
      ["vendor/a", summary({ repo: "vendor/a", ...VIOLATING })],
      ["vendor/b", summary({ repo: "vendor/b" })],
    ]);
    const byRepo = new Map(
      buildDemotionStatuses(repos).map((s) => [s.repo, s.onTemporaryDemotion])
    );
    expect(byRepo.get("vendor/a")).toBe(true);
    expect(byRepo.get("vendor/b")).toBe(false);
  });
});
