// Display-side reader for the advisory triage verdict a downstream repo can
// attach to its CRCR callback.

export const TRIAGE_CATEGORIES = [
  "upstream",
  "backend",
  "infra",
  "flake",
  "unknown",
] as const;
export const TRIAGE_CONFIDENCES = ["high", "medium", "low"] as const;

export type TriageCategory = (typeof TRIAGE_CATEGORIES)[number];
export type TriageConfidence = (typeof TRIAGE_CONFIDENCES)[number];

export interface TriageEvidence {
  job?: string;
  test?: string;
  excerpt?: string;
  log_url?: string;
}

export interface TriageVerdict {
  category: TriageCategory;
  confidence: TriageConfidence;
  summary: string;
  suspected_upstream?: { pr?: number; commit?: string; reason?: string };
  evidence?: TriageEvidence[];
  reproduced_on_retry?: boolean;
  analyzer?: {
    name?: string;
    version?: string;
    model?: string;
    prompt_version?: string;
  };
  analyzed_at?: string;
}

const COMMIT_RE = /^[0-9a-fA-F]{7,40}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

function isSuspectedUpstream(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const { pr, commit, reason } = value;
  return (
    (pr === undefined || (Number.isInteger(pr) && (pr as number) > 0)) &&
    (commit === undefined ||
      (typeof commit === "string" && COMMIT_RE.test(commit))) &&
    isOptionalString(reason)
  );
}

function isEvidence(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isOptionalString(value.job) &&
    isOptionalString(value.test) &&
    isOptionalString(value.excerpt) &&
    (value.log_url === undefined || isHttpUrl(value.log_url))
  );
}

function isAnalyzer(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return ["name", "version", "model", "prompt_version"].every((key) =>
    isOptionalString(value[key])
  );
}

function isTriageVerdict(value: unknown): value is TriageVerdict {
  if (!isRecord(value)) return false;
  const v = value;
  return (
    (TRIAGE_CATEGORIES as readonly unknown[]).includes(v.category) &&
    (TRIAGE_CONFIDENCES as readonly unknown[]).includes(v.confidence) &&
    typeof v.summary === "string" &&
    v.summary.trim() !== "" &&
    (v.suspected_upstream === undefined ||
      isSuspectedUpstream(v.suspected_upstream)) &&
    (v.evidence === undefined ||
      (Array.isArray(v.evidence) && v.evidence.every(isEvidence))) &&
    (v.reproduced_on_retry === undefined ||
      typeof v.reproduced_on_retry === "boolean") &&
    (v.analyzer === undefined || isAnalyzer(v.analyzer)) &&
    isOptionalString(v.analyzed_at)
  );
}

// `triage_verdict_json` as stored by /api/crcr/results; empty for most jobs.
export function parseTriageVerdict(
  json: string | null | undefined
): TriageVerdict | null {
  if (!json) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  return isTriageVerdict(value) ? value : null;
}

// Caveat 1 of #8673: the suspected upstream PR is not necessarily the PR under
// test. Naming the PR under test means it broke its own downstream CI; naming
// another one usually means a regression that is already on main. null when
// there is nothing to compare, e.g. nightly runs have no PR under test.
export function isSuspectedPrUnderTest(
  verdict: TriageVerdict,
  prNumber: number | null | undefined
): boolean | null {
  const suspected = verdict.suspected_upstream?.pr;
  if (suspected === undefined || !prNumber) return null;
  return suspected === prNumber;
}
