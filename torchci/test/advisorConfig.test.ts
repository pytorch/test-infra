import {
  getAdvisorRepoConfig,
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
});
