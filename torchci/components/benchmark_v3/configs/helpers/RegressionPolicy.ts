export type ComparisonVerdict = "good" | "neutral" | "regression";
export type ComparisonPolicyType = "ratio";
export const DEFAULT_TYPE = "ratio";
export const DEFAULT_BAD_RATIO = 0.9;
export const DEFAULT_GOOD_RATIO = 1.1;
export const DEFAULT_DIRECTION = "up";

export function getDefaultComparisonPolicy(
  target: string
): BenchmarkComparisonPolicyConfig {
  return {
    target,
    type: DEFAULT_TYPE,
    ratioPolicy: {
      badRatio: DEFAULT_BAD_RATIO,
      goodRatio: DEFAULT_GOOD_RATIO,
      direction: DEFAULT_DIRECTION,
    },
  };
}

export type BenchmarkComparisonPolicyConfig = {
  /** metric/column name this policy applies to */
  target: string;

  type?: ComparisonPolicyType;

  /** ratio-based thresholds relative to oldValue */
  ratioPolicy?: {
    /**
     * Optional threshold for "good" (clear improvement).
     *
     * Interpretation depends on `direction`:
     *  - direction = "up"   (higher is better):
     *      newValue >= oldValue * goodRatio → verdict = "good"
     *
     *  - direction = "down" (lower is better):
     *      newValue <= oldValue * goodRatio → verdict = "good"
     *
     * Example:
     *   direction = "up", goodRatio = 1.0
     *   → new must be >= old (no drop) to be considered good.
     *
     *   direction = "down", goodRatio = 0.95
     *   → new must be <= 95% of old (≥5% faster) to be considered good.
     */
    goodRatio?: number;

    /**
     * Mandatory threshold for "regression".
     *
     * Interpretation depends on `direction`:
     *  - direction = "up"   (higher is better):
     *      newValue <= oldValue * badRatio → verdict = "regression"
     *
     *  - direction = "down" (lower is better):
     *      newValue >= oldValue * badRatio → verdict = "regression"
     *
     * Example:
     *   direction = "up", badRatio = 0.98
     *   → new <= 98% of old (≥2% drop) is a regression.
     *
     *   direction = "down", badRatio = 1.10
     *   → new >= 110% of old (≥10% slower) is a regression.
     */
    badRatio: number;

    /**
     * Direction of improvement:
     *  - "up"   → higher newValue is better (typical for accuracy, pass rate, throughput).
     *  - "down" → lower newValue is better (typical for latency, memory, runtime).
     *
     * Default: "up".
     */
    direction?: "up" | "down";
  };
};

export type ComparisonResult = {
  target: string;
  oldValue: number | null;
  newValue: number | null;
  delta: number | null;
  verdict: ComparisonVerdict;
  reason?: string;
  isDefaultPolicy: boolean;
};

// ------------------------------------------------------------------
// Evaluator
// ------------------------------------------------------------------

export function evaluateComparison(
  target: string | undefined | null,
  oldValue: number | null | undefined,
  newValue: number | null | undefined,
  policy?: BenchmarkComparisonPolicyConfig
): ComparisonResult {
  if (!policy || policy.type == null) {
    policy = getDefaultComparisonPolicy("general");
  }
  const type: ComparisonPolicyType = policy.type ?? "ratio";
  const base: ComparisonResult = {
    target: target ?? "general",
    oldValue: oldValue ?? null,
    newValue: newValue ?? null,
    delta: oldValue != null && newValue != null ? newValue - oldValue : null,
    verdict: "neutral",
    isDefaultPolicy: !policy || policy.type == null,
  };
  // missing values → neutral
  if (
    oldValue == null ||
    newValue == null ||
    Number.isNaN(oldValue) ||
    Number.isNaN(newValue)
  ) {
    return { ...base, reason: "missing value" };
  }
  switch (type) {
    case "ratio": {
      const rp = policy.ratioPolicy ?? {
        badRatio: 0.9,
        goodRatio: 1.1,
        direction: "up",
      };
      const dir = rp.direction ?? "up";

      const calculatedGood = rp.goodRatio
        ? oldValue * rp.goodRatio
        : oldValue * DEFAULT_GOOD_RATIO;
      const calculatedBad = oldValue * rp.badRatio;
      // Compare with oldValue * ratio
      if (dir === "up") {
        if (rp.goodRatio != null && newValue > oldValue * rp.goodRatio) {
          return {
            ...base,
            verdict: "good",
            reason: `new > old * goodRatio (${
              rp.goodRatio
            })[${calculatedGood.toFixed(2)}]`,
          };
        }
        if (newValue < oldValue * rp.badRatio) {
          return {
            ...base,
            verdict: "regression",
            reason: `new < old * badRatio (${
              rp.badRatio
            })[${calculatedBad.toFixed(2)}]`,
          };
        }
        return {
          ...base,
          verdict: "neutral",
          reason: "between good/bad ratios",
        };
      } else {
        if (rp.goodRatio != null && newValue < oldValue * rp.goodRatio) {
          return {
            ...base,
            verdict: "good",
            reason: `new < old * goodRatio (${
              rp.goodRatio
            })[${calculatedGood.toFixed(2)}}]`,
          };
        }
        if (newValue > oldValue * rp.badRatio) {
          return {
            ...base,
            verdict: "regression",
            reason: `new > old * badRatio (${
              rp.badRatio
            })[${calculatedBad.toFixed(2)}]`,
          };
        }
        return {
          ...base,
          verdict: "neutral",
          reason: "between good/bad ratios",
        };
      }
    }
    default:
      return { ...base, verdict: "neutral", reason: "no policy" };
  }
}
