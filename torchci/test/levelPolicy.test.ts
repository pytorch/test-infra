import { levelPolicyPresentation } from "../lib/crcr/levelPolicy";

describe("levelPolicyPresentation", () => {
  it("describes L2 as progressing to L3", () => {
    const presentation = levelPolicyPresentation("L2");

    expect(presentation.title).toBe("Readiness for L3");
    expect(presentation.primaryLabel).toBe("L3 promotion (14d)");
    expect(presentation.showDemotionSignals).toBe(false);
  });

  it("keeps L3 temporary protection separate from a configured-level change", () => {
    const presentation = levelPolicyPresentation("L3");

    expect(presentation.title).toBe("L3 Operational Health");
    expect(presentation.showProtectionStatus).toBe(true);
    expect(presentation.description).toContain("remains configured at L3");
  });

  it("does not present the L3 metric baseline as automatic L4 readiness", () => {
    const presentation = levelPolicyPresentation("L4");

    expect(presentation.title).toBe("L4 Operational Status");
    expect(presentation.primaryLabel).toBe("L3 stability baseline (14d)");
    expect(presentation.secondaryLabel).toBe("Review triggers (7d)");
    expect(presentation.description).toContain("does not automatically demote");
  });

  it("does not fabricate metrics for L1", () => {
    const presentation = levelPolicyPresentation("L1");

    expect(presentation.showCriteria).toBe(false);
    expect(presentation.primarySummaryLabel).toBeNull();
  });
});
