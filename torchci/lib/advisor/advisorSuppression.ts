// Decides which NEW/unclassified failures the AI CI Advisor has cleared well
// enough to stop blocking a merge.
//
// Deliberately separate from advisorComment.ts. That module renders a display
// line and is gated by a display flag; this one moves a failure out of the
// blocking set, so it gets its own flag and a strictly narrower predicate.
// Everything here is fail-safe: any missing, stale, ambiguous or low-confidence
// verdict leaves the job blocking.

import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { drciSignalKeyForJob } from "lib/advisor/advisorBadge";
import { isAdvisorEnabled } from "lib/advisor/advisorConfig";
import { AdvisorVerdictRow } from "lib/advisorVerdictUtils";
import { isTime0 } from "lib/bot/utils";
import { queryClickhouseSaved } from "lib/clickhouse";
import { RecentWorkflowsData } from "lib/types";

dayjs.extend(utc);

// The only verdict that stops a failure from blocking. `infra_issue` is
// excluded on purpose: it means CI broke before producing a test outcome, so
// suppressing it would convert untested into green.
export const SUPPRESSIBLE_VERDICT = "not_related";

// The badge scale's `high` bucket. The UI already labels anything below this
// "probably not related" or "not related (uncertain)", and an uncertain verdict
// is not a basis for skipping a gate.
export const MIN_SUPPRESSION_CONFIDENCE = 0.89;

// A verdict describes one execution of a job, but is keyed only by (sha, job
// name), so a rerun at the same head would otherwise inherit the previous run's
// verdict. Requiring the verdict to be strictly newer than the job's completion
// rejects the common case: the rerun finishes after the old verdict was
// written, so the job blocks until a fresh analysis lands. Equality is treated
// as stale because these timestamps are truncated and a tie cannot be told
// apart from the unsafe ordering.
//
// KNOWN GAP, and the reason this ships behind a flag: a verdict for execution A
// that lands after execution B has finished still passes this test. Closing it
// needs the analyzed job id recorded on the verdict row -- the row's `run_id`
// is the advisor's own dispatch run, not the job's.
function verdictDescribesThisRun(
  job: RecentWorkflowsData,
  verdictTimestamp: string
): boolean {
  // isTime0 covers the epoch sentinel AND unparseable input (it NaN-checks), so
  // a malformed timestamp on either side blocks rather than passing.
  if (isTime0(job.completed_at) || isTime0(verdictTimestamp)) {
    return false;
  }
  return dayjs.utc(verdictTimestamp).isAfter(dayjs.utc(job.completed_at));
}

// Only a conclusive `failure` is eligible. `cancelled`, `timed_out`,
// `action_required` and friends did not produce a test outcome, and the advisor
// labels much of that class `not_related` anyway -- see the shadow-mode
// adjudication. This narrows that exposure; it does not close it, because a
// job can also fail without a real outcome (runner lost, driver fault) while
// still concluding `failure`. That residue is what the manual adjudication
// before enforcement is for.
export function producedATestOutcome(job: RecentWorkflowsData): boolean {
  return job.conclusion === "failure";
}

export function advisorSuppressionEnabled(
  owner: string,
  repo: string
): boolean {
  return (
    process.env.DRCI_ADVISOR_SUPPRESSION_ENABLED === "true" &&
    isAdvisorEnabled(owner, repo)
  );
}

/**
 * Pick the verdict for one signal key, keeping "ambiguous" distinct from
 * "absent". Rows tied at the newest timestamp with different verdicts mean an
 * answer arrived and is unusable, so the job keeps blocking rather than taking
 * whichever row sorted first. Tied rows that agree on the verdict but differ on
 * confidence resolve to the LOWEST, since confidence is part of the safety
 * decision too.
 *
 * Sorts rather than trusting the caller: the saved query orders by timestamp
 * with no tie-breaker, and "whatever ClickHouse returned first" is not a basis
 * for skipping a merge gate.
 */
export function resolveVerdict(
  rows: AdvisorVerdictRow[]
): { verdict: string; confidence: number; timestamp: string } | null {
  if (rows.length === 0) {
    return null;
  }
  const newestTimestamp = rows
    .map((r) => r.timestamp)
    .reduce((a, b) => (a > b ? a : b));
  const tied = rows.filter((r) => r.timestamp === newestTimestamp);
  if (tied.some((r) => r.verdict !== tied[0].verdict)) {
    return null;
  }
  return {
    verdict: tied[0].verdict,
    confidence: Math.min(...tied.map((r) => r.confidence)),
    timestamp: newestTimestamp,
  };
}

/** Whether one job's verdict clears it to stop blocking. Pure, for testing. */
export function isSuppressible(
  job: RecentWorkflowsData,
  rows: AdvisorVerdictRow[]
): boolean {
  if (!producedATestOutcome(job)) {
    return false;
  }
  const resolved = resolveVerdict(rows);
  if (resolved === null) {
    return false;
  }
  return (
    resolved.verdict === SUPPRESSIBLE_VERDICT &&
    resolved.confidence >= MIN_SUPPRESSION_CONFIDENCE &&
    verdictDescribesThisRun(job, resolved.timestamp)
  );
}

/**
 * Job ids among `jobs` that the advisor has cleared. Returns an empty set when
 * the flag is off, so the caller needs no separate check. The caller must also
 * wrap this: a ClickHouse error can never be allowed to break the comment.
 */
export async function fetchSuppressibleJobIds(
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
  jobs: RecentWorkflowsData[]
): Promise<Set<number>> {
  if (!advisorSuppressionEnabled(owner, repo) || jobs.length === 0) {
    return new Set();
  }

  const allRows = (await queryClickhouseSaved("advisor_verdicts_for_pr", {
    repo: `${owner}/${repo}`,
    prNumber,
  })) as AdvisorVerdictRow[];

  // Rows arrive newest-first; keep only this head's, grouped by signal key.
  const rowsByKey = new Map<string, AdvisorVerdictRow[]>();
  for (const row of allRows) {
    if (row.sha.trim() !== headSha) {
      continue;
    }
    const key = row.signal_key;
    rowsByKey.set(key, (rowsByKey.get(key) ?? []).concat(row));
  }

  const suppressible = new Set<number>();
  for (const job of jobs) {
    if (!job.name) {
      continue;
    }
    const rows = rowsByKey.get(drciSignalKeyForJob(job.name)) ?? [];
    if (isSuppressible(job, rows)) {
      suppressible.add(job.id);
    }
  }
  return suppressible;
}

/**
 * Move cleared jobs out of `blocking` and return them, mutating the array in
 * place. In place because drci.ts hands the same array object to both the
 * failures dict and the comment renderer, and CRCR L4 pushes into it later --
 * rebinding would silently desync those.
 */
export function extractSuppressed(
  blocking: RecentWorkflowsData[],
  suppressibleIds: Set<number>
): RecentWorkflowsData[] {
  const extracted: RecentWorkflowsData[] = [];
  for (let i = blocking.length - 1; i >= 0; i--) {
    if (suppressibleIds.has(blocking[i].id)) {
      extracted.unshift(blocking[i]);
      blocking.splice(i, 1);
    }
  }
  return extracted;
}
