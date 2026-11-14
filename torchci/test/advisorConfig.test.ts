import {
  getAdvisorRepoConfig,
  getMaxNewFailures,
  isAdvisorEnabled,
} from "lib/advisor/advisorConfig";

describe("advisorConfig", () => {
  it("returns config for an enabled repo", () => {
    const cfg = getAdvisorRepoConfig("pytorch", "pytorch");
    expect(cfg).toBeDefined();
    expect(cfg?.workflowFile).toBe("claude-autorevert-advisor.yml");
    expect(isAdvisorEnabled("pytorch", "pytorch")).toBe(true);
  });

  it("returns undefined / false for a disabled repo", () => {
    expect(getAdvisorRepoConfig("pytorch", "vision")).toBeUndefined();
    expect(isAdvisorEnabled("pytorch", "vision")).toBe(false);
    expect(isAdvisorEnabled("some", "other")).toBe(false);
  });

  it("dispatches up to trymerge's cap on AI-cleared failures in one merge", () => {
    // IGNORABLE_FAILED_CHECKS_THESHOLD in pytorch/pytorch's
    // .github/scripts/trymerge.py. Change both together.
    expect(getMaxNewFailures("pytorch", "pytorch")).toBe(10);
  });
});
