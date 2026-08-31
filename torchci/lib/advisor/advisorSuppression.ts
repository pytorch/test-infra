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
import {
  confidenceBucket,
  drciSignalKeyForJob,
} from "lib/advisor/advisorBadge";
import { advisorSuppressionEnabled } from "lib/advisor/advisorFlags";
import {
  AdvisorVerdictRow,
  AdvisorVerdictType,
  headRowsBySignalKey,
  resolveVerdict,
} from "lib/advisorVerdictUtils";
import { isTime0 } from "lib/bot/utils";
import { RecentWorkflowsData } from "lib/types";

dayjs.extend(utc);

// Every advisor verdict and whether it stops a failure from blocking.
//
// Written as a TOTAL map rather than a list of the cleared ones: adding a member
// to AdvisorVerdictType then fails to compile here until someone decides which
// side it falls on, which is the decision most likely to be skipped.
//
//   not_related  the failure exists independently of this change
//   infra_issue  the environment broke -- credentials, image pull, runner loss
//   garbage      the signal itself is noise: it flips red/green across unrelated
//                commits, and the baselines fail the same way
//   related      the opposite claim -- this change caused it
//   revert       the trunk-side spelling of `related`
//   unsure       no claim was reached
//
// `garbage` sits with the cleared ones rather than with `unsure` because it is
// an EVIDENCED claim about the signal, not an absence of one: the advisor
// reaches it by comparing the job against its own baselines. `unsure` is the
// real "cannot tell", and it blocks.
//
// LIMIT, stated because the confidence and freshness gates do not cover it: a
// verdict says the failure looks environmental, not that the PR is innocent of
// causing it. A change to CI config, a Dockerfile, or a submodule pin can
// produce a genuine infrastructure-shaped failure that IS the PR's fault, and
// `infra_issue` is where that lands. `producedATestOutcome` below narrows this
// -- it gates on the job's own conclusion rather than the advisor's opinion, so
// an infra fault that left the job `cancelled` never reaches here -- but it does
// not close it, since a job can conclude `failure` having tested nothing. The
// remaining exposure is bounded by the merge-side cap on how many gates one
// merge may skip, and by this shipping behind a flag.
const VERDICT_DISPOSITION: Record<AdvisorVerdictType, "clear" | "block"> = {
  not_related: "clear",
  infra_issue: "clear",
  garbage: "clear",
  related: "block",
  revert: "block",
  unsure: "block",
};

export const SUPPRESSIBLE_VERDICTS: ReadonlySet<string> = new Set(
  Object.entries(VERDICT_DISPOSITION)
    .filter(([, disposition]) => disposition === "clear")
    .map(([verdict]) => verdict)
);

// Clear only what the badge scale calls high confidence. Asks advisorBadge for
// the bucket rather than restating its threshold, so retuning the scale moves
// the gate with it instead of leaving the comment saying "probably not related"
// while this still suppresses.
export function confidentEnoughToSuppress(confidence: number): boolean {
  return confidenceBucket(confidence) === "high";
}

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
    SUPPRESSIBLE_VERDICTS.has(resolved.verdict) &&
    confidentEnoughToSuppress(resolved.confidence) &&
    verdictDescribesThisRun(job, resolved.timestamp)
  );
}

/**
 * Job ids among `jobs` that the advisor has cleared. Returns an empty set when
 * the flag is off, so the caller needs no separate check.
 *
 * Takes the PR's verdict rows rather than reading them: drci.ts reads once and
 * shares them with the badge line, so the comment and the gate cannot disagree
 * about a job. Rows for any other commit are dropped here, so a verdict from an
 * earlier head can never clear a job at this one.
 */
export function suppressibleJobIds(
  owner: string,
  repo: string,
  headSha: string,
  jobs: RecentWorkflowsData[],
  verdictRows: AdvisorVerdictRow[]
): Set<number> {
  if (!advisorSuppressionEnabled(owner, repo) || jobs.length === 0) {
    return new Set();
  }

  const rowsByKey = headRowsBySignalKey(verdictRows, headSha);

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
