/**
 * AI Advisor verdict types and matching logic for HUD overlay.
 *
 * Advisor verdicts come from misc.autorevert_advisor_verdicts in ClickHouse.
 * They need to be matched to HUD job cells by (sha, workflow:signal_key).
 *
 * Signal key formats:
 * - Job-track: "linux-jammy-py3.10-gcc11 / test" (matches job name prefix)
 * - Test-track: "test_cuda.py::test_allocator_settings" (test within a job)
 */

export type AdvisorVerdictType =
  | "revert"
  | "unsure"
  | "not_related"
  | "garbage";

export interface AdvisorVerdict {
  sha: string;
  signalKey: string;
  signalSource: "job" | "test" | string;
  workflowName: string;
  verdict: AdvisorVerdictType;
  confidence: number;
  summary: string;
  causalReasoning: string;
  runId: number;
  prNumber: number;
  timestamp: string;
}

/** Raw row from the ClickHouse query */
export interface AdvisorVerdictRow {
  sha: string;
  signal_key: string;
  signal_source: string;
  workflow_name: string;
  verdict: string;
  confidence: number;
  summary: string;
  causal_reasoning: string;
  run_id: number;
  pr_number: number;
  timestamp: string;
}

/** Deduplicate verdicts: keep the most recent per (sha, signal_key) */
export function deduplicateVerdicts(
  rows: AdvisorVerdictRow[]
): AdvisorVerdict[] {
  const seen = new Set<string>();
  const results: AdvisorVerdict[] = [];

  // Rows are already ordered by timestamp DESC per (sha, signal_key)
  for (const row of rows) {
    const key = `${row.sha}:${row.signal_key}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({
      sha: row.sha.trim(),
      signalKey: row.signal_key,
      signalSource: row.signal_source,
      workflowName: row.workflow_name,
      verdict: row.verdict as AdvisorVerdictType,
      confidence: row.confidence,
      summary: row.summary,
      causalReasoning: row.causal_reasoning,
      runId: row.run_id,
      prNumber: row.pr_number,
      timestamp: row.timestamp,
    });
  }
  return results;
}

/**
 * Build a lookup map: sha -> array of verdicts for that commit.
 */
export function buildVerdictsBySha(
  verdicts: AdvisorVerdict[]
): Map<string, AdvisorVerdict[]> {
  const map = new Map<string, AdvisorVerdict[]>();
  for (const v of verdicts) {
    const list = map.get(v.sha) ?? [];
    list.push(v);
    map.set(v.sha, list);
  }
  return map;
}

/**
 * Normalize a job-track signal key for matching against HUD job names.
 * Strips the " [test]" suffix that autorevert uses to distinguish
 * job-track-test signals from plain job-track signals, since the HUD
 * job names don't have this suffix.
 */
function normalizeJobSignalKey(key: string): string {
  return key.replace(/ \[test\]$/, "").trim();
}

/**
 * Match a HUD job to an advisor verdict for a given sha.
 *
 * HUD job names look like: "trunk / linux-jammy-py3.10-gcc11 / test (default, 1, 5, linux...)"
 * Advisor signal keys look like:
 *   - Job-track: "linux-jammy-py3.10-gcc11 / test" or "... / test [test]"
 *   - Test-track: "test_cuda.py::test_allocator_settings"
 *
 * Job-track: match by workflow + prefix (after stripping shard parens and [test] suffix).
 * Test-track: match by checking if any failureCaptures entry contains the
 *   test file and test name from the signal key.
 */
export function matchVerdictToJob(
  hudJobName: string,
  verdicts: AdvisorVerdict[],
  failureCaptures?: string[]
): AdvisorVerdict | undefined {
  if (!verdicts || verdicts.length === 0) return undefined;

  // Extract workflow and job parts from HUD name: "trunk / linux-jammy-... / test (...)"
  const slashIdx = hudJobName.indexOf(" / ");
  if (slashIdx === -1) return undefined;

  const hudWorkflow = hudJobName.substring(0, slashIdx).trim().toLowerCase();
  const hudJobPart = hudJobName
    .substring(slashIdx + 3)
    .trim()
    .toLowerCase()
    // Strip trailing shard parenthetical: "test (default, 1, 5, ...)" -> "test"
    .replace(/ \([^)]*\)$/, "")
    .trim();

  // Try job-track verdicts first (exact match is strongest signal)
  for (const v of verdicts) {
    if (v.signalSource !== "job") continue;

    const vWorkflow = v.workflowName.toLowerCase();
    const vKey = normalizeJobSignalKey(v.signalKey).toLowerCase();

    if (hudWorkflow !== vWorkflow) continue;

    if (hudJobPart === vKey || hudJobPart.startsWith(vKey + " ")) {
      return v;
    }
  }

  // Try test-track verdicts: match signal key against failureCaptures
  // Signal key format: "test_file.py::test_name"
  // Capture format: "test_file.py::TestClass::test_name"
  if (failureCaptures && failureCaptures.length > 0) {
    const capturesLower = failureCaptures.map((c) => c.toLowerCase());
    for (const v of verdicts) {
      if (v.signalSource !== "test") continue;
      if (v.workflowName.toLowerCase() !== hudWorkflow) continue;

      // Signal key: "test_file.py::test_name"
      // Split into file and test parts
      const sepIdx = v.signalKey.indexOf("::");
      if (sepIdx === -1) continue;
      const sigFile = v.signalKey.substring(0, sepIdx).toLowerCase();
      const sigTest = v.signalKey.substring(sepIdx + 2).toLowerCase();

      for (const cap of capturesLower) {
        // Check if capture contains both the file and test name
        if (cap.includes(sigFile) && cap.includes(sigTest)) {
          return v;
        }
      }
    }
  }

  return undefined;
}

/**
 * Build the GitHub Actions URL for the advisor run.
 */
export function advisorRunUrl(
  verdict: AdvisorVerdict,
  repo: string = "pytorch/pytorch"
): string {
  return `https://github.com/${repo}/actions/runs/${verdict.runId}`;
}
