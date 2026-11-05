export type CrcrLevel = "L1" | "L2" | "L3" | "L4";

export type LevelPolicyPresentation = {
  title: string;
  description: string;
  primaryLabel: string;
  secondaryLabel: string;
  primarySummaryLabel: string | null;
  secondarySummaryLabel: string | null;
  primaryCriteria: "promotion" | "operational";
  showCriteria: boolean;
  showSecondaryColumn: boolean;
  showDemotionSignals: boolean;
  showProtectionStatus: boolean;
  configuredStatus: string;
};

const PRESENTATIONS: Record<CrcrLevel, LevelPolicyPresentation> = {
  L1: {
    title: "L1 Onboarding Status",
    description:
      "L1 delivers upstream events. Quantitative readiness criteria begin at L2; configured-level decisions and their evidence are available in Configured-Level History below.",
    primaryLabel: "Not evaluated",
    secondaryLabel: "Next decision",
    primarySummaryLabel: null,
    secondarySummaryLabel: null,
    primaryCriteria: "promotion",
    showCriteria: false,
    showSecondaryColumn: false,
    showDemotionSignals: false,
    showProtectionStatus: false,
    configuredStatus: "Configured: L1 · event delivery",
  },
  L2: {
    title: "Readiness for L3",
    description:
      "L3 promotion is evaluated over the fixed 14-day window. L3 temporary-protection and demotion policy begin only after this backend is promoted to L3.",
    primaryLabel: "L3 promotion (14d)",
    secondaryLabel: "Not evaluated at L2",
    primarySummaryLabel: "L3 promotion",
    secondarySummaryLabel: null,
    primaryCriteria: "promotion",
    showCriteria: true,
    showSecondaryColumn: true,
    showDemotionSignals: false,
    showProtectionStatus: false,
    configuredStatus: "Configured: L2 · callback-only",
  },
  L3: {
    title: "L3 Operational Health",
    description:
      "The 14-day baseline shows the five operational L3 metrics; time spent at L2 is a promotion prerequisite and is not part of this view. A failed 7-day trigger can activate temporary protection while the backend remains configured at L3 until an allowlist change is merged. L4 progression remains a Core Maintainer decision.",
    primaryLabel: "L3 health baseline (14d)",
    secondaryLabel: "Temporary-protection triggers (7d)",
    primarySummaryLabel: "L3 health",
    secondarySummaryLabel: "Demotion",
    primaryCriteria: "operational",
    showCriteria: true,
    showSecondaryColumn: true,
    showDemotionSignals: true,
    showProtectionStatus: true,
    configuredStatus: "Configured: L3 · label-only checks",
  },
  L4: {
    title: "L4 Operational Status",
    description:
      "The 14-day view shows the five operational L3 metrics for context. They do not define or automate L4 promotion, demotion, or review; L4 configured-level decisions remain Core Maintainer governance decisions.",
    primaryLabel: "L3 health baseline (14d)",
    secondaryLabel: "",
    primarySummaryLabel: "L3 health",
    secondarySummaryLabel: null,
    primaryCriteria: "operational",
    showCriteria: true,
    showSecondaryColumn: false,
    showDemotionSignals: false,
    showProtectionStatus: false,
    configuredStatus: "Configured: L4 · merge-gating",
  },
};

const UNKNOWN_PRESENTATION: LevelPolicyPresentation = {
  title: "CRCR Policy Status",
  description:
    "The configured level is unavailable. The quantitative signals below use the existing L3 policy until level configuration can be loaded.",
  primaryLabel: "Promotion (14d)",
  secondaryLabel: "Demotion (7d)",
  primarySummaryLabel: "Promotion",
  secondarySummaryLabel: "Demotion",
  primaryCriteria: "promotion",
  showCriteria: true,
  showSecondaryColumn: true,
  showDemotionSignals: true,
  showProtectionStatus: false,
  configuredStatus: "Configured level unavailable",
};

export function levelPolicyPresentation(
  level: CrcrLevel | null
): LevelPolicyPresentation {
  return level ? PRESENTATIONS[level] : UNKNOWN_PRESENTATION;
}
