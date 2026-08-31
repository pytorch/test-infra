// Server-side glue for the inline AI advisor verdict lines in the Dr.CI comment.
// Reads finalized verdicts + in-progress dispatch state from ClickHouse, then
// delegates the (pure) line selection/rendering to lib/advisor/advisorBadge.
//
// The verdict's signal_key is exactly `dr_ci_${jobName}` (what auto-dispatch
// wrote), so verdicts match jobs by exact signal-key equality -- no fuzzy
// matchVerdictToJob needed for the PR side.

import {
  AdvisorLineVerdict,
  selectAdvisorLines,
} from "lib/advisor/advisorBadge";
import {
  readDispatchStates,
  signalKeyForJob,
} from "lib/advisor/advisorDispatch";
import { advisorCommentEnabled } from "lib/advisor/advisorFlags";
import {
  AdvisorVerdictRow,
  headRowsBySignalKey,
  resolveVerdict,
} from "lib/advisorVerdictUtils";
import { RecentWorkflowsData } from "lib/types";

/**
 * Build the per-job "AI verdict:" line for a PR's new/unclassified failures.
 * Returns job.id -> rendered HTML (empty map when the comment flag is off, the
 * repo isn't advisor-enabled, or there are no jobs). The caller wraps this so a
 * ClickHouse error can never break the Dr.CI comment.
 *
 * Takes the PR's verdict rows rather than reading them, so this line and the
 * suppression gate describe the same rows resolved the same way. A signal key
 * whose newest rows disagree resolves to nothing here too, and the job falls
 * through to the pending/in-progress treatment below -- an unusable answer
 * should not render as a confident badge.
 */
export async function buildAdvisorVerdictLines(
  hudBaseUrl: string,
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
  jobs: RecentWorkflowsData[],
  verdictRows: AdvisorVerdictRow[]
): Promise<Map<number, string>> {
  if (!advisorCommentEnabled(owner, repo) || jobs.length === 0) {
    return new Map();
  }

  // Finalized verdicts for this PR, keyed by signal_key for the head commit.
  const verdictByKey = new Map<string, AdvisorLineVerdict>();
  for (const [signalKey, rows] of headRowsBySignalKey(verdictRows, headSha)) {
    const resolved = resolveVerdict(rows);
    if (resolved !== null) {
      verdictByKey.set(signalKey, {
        verdict: resolved.verdict,
        confidence: resolved.confidence,
        summary: resolved.summary,
      });
    }
  }

  // In-progress dispatches (dispatching/dispatched) for the head commit.
  const signalKeys = jobs
    .filter((j) => j.name)
    .map((j) => signalKeyForJob(j.name));
  const states = await readDispatchStates(owner, repo, headSha, signalKeys);
  const inProgressKeys = new Set<string>();
  for (const [key, st] of states) {
    if (st.state === "dispatching" || st.state === "dispatched") {
      inProgressKeys.add(key);
    }
  }

  return selectAdvisorLines(
    hudBaseUrl,
    owner,
    repo,
    prNumber,
    headSha,
    jobs.map((j) => ({ id: j.id, name: j.name })),
    verdictByKey,
    inProgressKeys
  );
}
