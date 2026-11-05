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
    expect(presentation.primaryCriteria).toBe("operational");
    expect(presentation.showProtectionStatus).toBe(true);
    expect(presentation.description).toContain("remains configured at L3");
  });

  it("keeps L4 metrics informational without inventing a review workflow", () => {
    const presentation = levelPolicyPresentation("L4");

    expect(presentation.title).toBe("L4 Operational Status");
    expect(presentation.primaryCriteria).toBe("operational");
    expect(presentation.primaryLabel).toBe("L3 health baseline (14d)");
    expect(presentation.secondarySummaryLabel).toBeNull();
    expect(presentation.showSecondaryColumn).toBe(false);
    expect(presentation.description).toContain("do not define or automate");
  });

  it("does not fabricate metrics for L1", () => {
    const presentation = levelPolicyPresentation("L1");

    expect(presentation.showCriteria).toBe(false);
    expect(presentation.primarySummaryLabel).toBeNull();
  });
});
