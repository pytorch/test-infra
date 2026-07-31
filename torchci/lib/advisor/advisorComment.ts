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
import { isAdvisorEnabled } from "lib/advisor/advisorConfig";
import {
  readDispatchStates,
  signalKeyForJob,
} from "lib/advisor/advisorDispatch";
import {
  AdvisorVerdictRow,
  deduplicateVerdicts,
} from "lib/advisorVerdictUtils";
import { queryClickhouseSaved } from "lib/clickhouse";
import { RecentWorkflowsData } from "lib/types";

// Gate the inline verdict rendering behind its own flag so it ships dark and
// can be enabled per deployment (Vercel env var), independently of the
// auto-dispatch flag. Display-only, so it doesn't also require VERCEL_ENV
// (unlike auto-dispatch, which fires real workflow_dispatches).
export function advisorCommentEnabled(owner: string, repo: string): boolean {
  return (
    process.env.DRCI_ADVISOR_COMMENT_ENABLED === "true" &&
    isAdvisorEnabled(owner, repo)
  );
}

/**
 * Build the per-job "AI verdict:" line for a PR's new/unclassified failures.
 * Returns job.id -> rendered HTML (empty map when the comment flag is off, the
 * repo isn't advisor-enabled, or there are no jobs). The caller wraps this so a
 * ClickHouse error can never break the Dr.CI comment.
 */
export async function buildAdvisorVerdictLines(
  hudBaseUrl: string,
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
  jobs: RecentWorkflowsData[]
): Promise<Map<number, string>> {
  if (!advisorCommentEnabled(owner, repo) || jobs.length === 0) {
    return new Map();
  }

  // Finalized verdicts for this PR, keyed by signal_key for the head commit.
  const verdictRows = (await queryClickhouseSaved("advisor_verdicts_for_pr", {
    repo: `${owner}/${repo}`,
    prNumber,
  })) as AdvisorVerdictRow[];
  const verdictByKey = new Map<string, AdvisorLineVerdict>();
  for (const v of deduplicateVerdicts(verdictRows)) {
    if (v.sha === headSha) {
      verdictByKey.set(v.signalKey, {
        verdict: v.verdict,
        confidence: v.confidence,
        summary: v.summary,
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
