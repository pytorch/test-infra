import { shouldReadAdvisorVerdicts } from "lib/advisor/advisorVerdictSource";
import { RecentWorkflowsData } from "lib/types";

const JOBS = [
  { id: 1, name: "pull / build" },
] as unknown as RecentWorkflowsData[];
const NO_JOBS: RecentWorkflowsData[] = [];

// pytorch/pytorch is advisor-enabled in advisorConfig; this one is not.
const OFF_REPO = "not-an-advisor-repo";

function withFlags(
  comment: string | undefined,
  suppression: string | undefined,
  fn: () => void
) {
  const savedC = process.env.DRCI_ADVISOR_COMMENT_ENABLED;
  const savedS = process.env.DRCI_ADVISOR_SUPPRESSION_ENABLED;
  const set = (k: string, v: string | undefined) =>
    v === undefined ? delete process.env[k] : (process.env[k] = v);
  set("DRCI_ADVISOR_COMMENT_ENABLED", comment);
  set("DRCI_ADVISOR_SUPPRESSION_ENABLED", suppression);
  try {
    fn();
  } finally {
    set("DRCI_ADVISOR_COMMENT_ENABLED", savedC);
    set("DRCI_ADVISOR_SUPPRESSION_ENABLED", savedS);
  }
}

describe("shouldReadAdvisorVerdicts", () => {
  test("both flags off means no read", () => {
    withFlags("false", "false", () => {
      expect(shouldReadAdvisorVerdicts("pytorch", "pytorch", JOBS)).toBe(false);
    });
  });

  test("the comment flag alone is enough to read", () => {
    withFlags("true", "false", () => {
      expect(shouldReadAdvisorVerdicts("pytorch", "pytorch", JOBS)).toBe(true);
    });
  });

  test("the suppression flag alone is enough to read", () => {
    withFlags("false", "true", () => {
      expect(shouldReadAdvisorVerdicts("pytorch", "pytorch", JOBS)).toBe(true);
    });
  });

  // The regression this guard exists for: most PRs have no new or unclassified
  // failures, and both consumers bail on an empty list, so reading for them
  // would be a ClickHouse round trip per PR that nothing can use.
  test("no eligible jobs means no read even with both flags on", () => {
    withFlags("true", "true", () => {
      expect(shouldReadAdvisorVerdicts("pytorch", "pytorch", NO_JOBS)).toBe(
        false
      );
    });
  });

  test("an advisor-disabled repo means no read", () => {
    withFlags("true", "true", () => {
      expect(shouldReadAdvisorVerdicts("pytorch", OFF_REPO, JOBS)).toBe(false);
    });
  });

  test("an unset flag is off, not on", () => {
    withFlags(undefined, undefined, () => {
      expect(shouldReadAdvisorVerdicts("pytorch", "pytorch", JOBS)).toBe(false);
    });
  });
});
