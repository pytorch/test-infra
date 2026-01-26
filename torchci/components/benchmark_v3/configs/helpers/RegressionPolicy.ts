import { asNumber } from "components/benchmark_v3/components/dataRender/components/benchmarkTimeSeries/components/BenchmarkTimeSeriesComparisonSection/BenchmarkTimeSeriesComparisonTable/ComparisonTableHelpers";

export type ComparisonVerdict =
  | "good"
  | "neutral"
  | "regression"
  | "warning"
  | "missing";
export type ComparisonPolicyType = "ratio" | "status" | "threshold";
export const DEFAULT_TYPE = "ratio";
export const DEFAULT_BAD_RATIO = 0.9;
export const DEFAULT_GOOD_RATIO = 1.1;
export const DEFAULT_DIRECTION = "up";

export function getDefaultNumericComparisonPolicy(
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

export function getDefaultStatusComparisonPolicy(
  target: string
): BenchmarkComparisonPolicyConfig {
  return {
    target,
    type: "status",
    statusPolicy: {
      goodValuePatterns: ["pass"],
      badValuePatterns: ["fail"],
    },
  };
}

export type BenchmarkStatusComparisonPolicy = {
  /**
   * ex target accuracy with value pass, pass_due_to_skip, fail_accuracy, fail_to_run
   *
   * if oldvalue is pass but newValue is any fail, consider bad
   * if oldvalue is pass and newValue is pass, consider neutrual
   * if oldvalue is fail but new value is any pass, consider good
   * if oldvalue and new value both fails, consider neutrual but warning
   * else consider neutrual
   */
  /** "good" (indicate desired value) */
  goodValues?: string[];
  goodValuePatterns?: string[];

  /** "bad" (indicated failure) */
  badValues?: string[];
  badValuePatterns?: string[];
};

export type BenchmarkComparisonPolicyConfig = {
  /** metric/column name this policy applies to */
  target: string;

  type?: ComparisonPolicyType;

  /** status-based thresholds relative to oldValue, this assume everything should be string */
  statusPolicy?: BenchmarkStatusComparisonPolicy;

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
  oldValue: number | string | null;
  newValue: number | string | null;
  delta: number | null;
  verdict: ComparisonVerdict;
  reason?: string;
  isDefaultPolicy: boolean;
};

// ------------------------------------------------------------------
// Main Evaluator Method
// ----------------------------------------------------------------
export function evaluateComparison(
  target: string | undefined | null,
  oldValue: any,
  newValue: any,
  policy?: BenchmarkComparisonPolicyConfig
): ComparisonResult {
  // by default we assume the metrics are numberic
  if (!policy || policy.type == null) {
    policy = getDefaultNumericComparisonPolicy("general");
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
  switch (type) {
    case "ratio":
      return evaluateNumericComparison(target, oldValue, newValue, policy);
    case "status":
      return evaluateStatusComparison(target, oldValue, newValue, policy);
    default:
      return { ...base, verdict: "neutral", reason: "no policy" };
  }
}

// ------------------------------------------------------------------
// Status Evaluator
// ----------------------------------------------------------------
export function evaluateStatusComparison(
  target: string | undefined | null,
  oldValue: string | null | undefined,
  newValue: string | null | undefined,
  policy?: BenchmarkComparisonPolicyConfig
): ComparisonResult {
  if (!policy || !policy.statusPolicy) {
    policy = getDefaultStatusComparisonPolicy(target ?? "general");
  }

  const base: ComparisonResult = {
    target: target ?? "general",
    oldValue: oldValue ?? null,
    newValue: newValue ?? null,
    delta: null,
    verdict: "neutral",
    isDefaultPolicy: !policy || policy.type == null,
  };

  if (policy.statusPolicy) {
    const { verdict, reason } = compareStatus(
      oldValue,
      newValue,
      policy.statusPolicy
    );
    return {
      ...base,
      verdict,
      reason,
    };
  }
  return {
    ...base,
    verdict: "neutral",
    reason: "No status comparison policy detected, please investigate",
  };
}

// ------------------------------------------------------------------
// Numeric Evaluator
// ------------------------------------------------------------------

export function evaluateNumericComparison(
  target: string | undefined | null,
  oldValue: number | null | undefined,
  newValue: number | null | undefined,
  policy?: BenchmarkComparisonPolicyConfig
): ComparisonResult {
  if (!policy || policy.type == null) {
    policy = getDefaultNumericComparisonPolicy("general");
  }

  oldValue = asNumber(oldValue);
  newValue = asNumber(newValue);

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
        reason: `new < old * badRatio (${rp.badRatio})[${calculatedBad.toFixed(
          2
        )}]`,
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
        reason: `new > old * badRatio (${rp.badRatio})[${calculatedBad.toFixed(
          2
        )}]`,
      };
    }
    return {
      ...base,
      verdict: "neutral",
      reason: "between good/bad ratios",
    };
  }
}

function matchExactOrIncludes(v: string, exact?: string[], pats?: string[]) {
  const x = v.toLowerCase();
  if (exact?.some((g) => g.toLowerCase() === x)) return true;
  if (pats?.some((p) => x.includes(p.toLowerCase()))) return true;
  return false;
}

function isGoodStatus(v: any, p: BenchmarkStatusComparisonPolicy): boolean {
  const s = String(v ?? "");
  // explicit lists first
  if (matchExactOrIncludes(s, p.goodValues, p.goodValuePatterns)) return true;
  // fallback heuristic if no config provided
  if (!p.goodValues && !p.goodValuePatterns)
    return s.toLowerCase().includes("pass");
  return false;
}

function isBadStatus(v: any, p: BenchmarkStatusComparisonPolicy): boolean {
  const s = String(v ?? "");
  // explicit lists first
  if (matchExactOrIncludes(s, p.badValues, p.badValuePatterns)) return true;
  // fallback heuristic if no config provided
  if (!p.badValues && !p.badValuePatterns)
    return s.toLowerCase().includes("fail");
  // if not matched explicitly, treat as not-bad (unknown/neutral)
  return false;
}

export function compareStatus(
  oldValue: any,
  newValue: any,
  policy: BenchmarkStatusComparisonPolicy
): any {
  const wasGood = isGoodStatus(oldValue, policy);
  const wasBad = isBadStatus(oldValue, policy);
  const isGood_ = isGoodStatus(newValue, policy);
  const isBad_ = isBadStatus(newValue, policy);

  // 1) old pass -> any fail => bad
  if (wasGood && isBad_) {
    return {
      verdict: "regression",
      reason: `Previously "${oldValue}" was good, but now "${newValue}" indicates failure.`,
    };
  }

  // 2) old pass -> new pass => neutral
  if (wasGood && isGood_) {
    return {
      verdict: "neutral",
      reason: `Both "${oldValue}" and "${newValue}" are good.`,
    };
  }

  // 3) old fail -> any pass => good
  if (wasBad && isGood_) {
    return {
      verdict: "good",
      reason: `Previously "${oldValue}" failed, now "${newValue}" passed.`,
    };
  }

  // 4) old fail -> new fail => neutral but warning
  if (wasBad && isBad_) {
    return {
      verdict: "warning",
      reason: `Both "${oldValue}" and "${newValue}" indicate failure.`,
    };
  }

  // Defaults for unknown/mixed cases
  if (wasGood && !isGood_ && !isBad_) {
    return {
      verdict: "warning",
      reason: `Previously "${oldValue}" was good, new value "${newValue}" is unknown.`,
    };
  }

  if (wasBad && !isGood_ && !isBad_) {
    return {
      verdict: "warning",
      reason: `Previously "${oldValue}" failed, new value "${newValue}" is unclear.`,
    };
  }

  if (!wasGood && !wasBad && isGood_) {
    return {
      verdict: "good",
      reason: `Previously unknown status "${oldValue}", now improved to good "${newValue}".`,
    };
  }

  if (!wasGood && !wasBad && isBad_) {
    return {
      verdict: "regression",
      reason: `Previously unknown status "${oldValue}", now failed with "${newValue}".`,
    };
  }

  return {
    verdict: "neutral",
    reason: `No clear status change between "${oldValue}" and "${newValue}".`,
  };
}
