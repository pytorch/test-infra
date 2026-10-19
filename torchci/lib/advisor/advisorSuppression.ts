// Decides which NEW/unclassified failures the AI CI Advisor has cleared well
// enough to stop blocking a merge.
//
// Deliberately separate from advisorComment.ts. That module renders a display
// line and is gated by a display flag; this one moves a failure out of the
// blocking set, so it gets its own flag and a strictly narrower predicate.
// Everything here is fail-safe: any missing, stale, ambiguous or low-confidence
// verdict leaves the job blocking.

import {
  confidenceBucket,
  DispatchMark,
  drciSignalKeyForJob,
  runJobId,
  verdictCoversRun,
} from "lib/advisor/advisorBadge";
import { advisorSuppressionEnabled } from "lib/advisor/advisorFlags";
import {
  AdvisorVerdictRow,
  AdvisorVerdictType,
  headRowsBySignalKey,
  resolveVerdict,
} from "lib/advisorVerdictUtils";
import { isExcludedFromAdvisor } from "lib/drciUtils";
import { RecentWorkflowsData } from "lib/types";

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
// not close it, since a job can conclude `failure` having tested nothing.
// Nothing on this side bounds how many such jobs one merge may skip; a
// per-merge cap is proposed in pytorch/pytorch#195503. Unless such a cap is
// deployed, the flag being off is what holds this residue.
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

// `infra_issue` clears from 0.85. Calibrated against trunk outcomes of merged
// PRs (Aug-Oct 2026): the job went newly red on main after the merge for 0 of 15
// scored `infra_issue` verdicts at 0.85-0.88, 1 of 36 at 0.89-0.92 and 6 of 291
// at >= 0.93. The new band is small and only covers PRs that merged anyway, so
// the AI suppression dashboard is the check that it holds up.
export const INFRA_ISSUE_MIN_CONFIDENCE = 0.85;

// Every other cleared verdict needs what the badge scale calls high confidence.
// Asks advisorBadge for the bucket rather than restating its threshold, so
// retuning the scale moves the gate with it.
//
// That keeps badge and gate in step for `not_related` -- the only cleared
// verdict whose label is hedged by confidence, so it is the only one that could
// read "probably not related" while this suppressed. `verdictBadge` returns for
// `garbage` and `infra_issue` before it consults the bucket, so those labels
// never hedge, which is why `infra_issue` can take its own floor without the
// comment and the gate disagreeing.
export function confidentEnoughToSuppress(
  verdict: string,
  confidence: number
): boolean {
  if (verdict === "infra_issue") {
    return confidence >= INFRA_ISSUE_MIN_CONFIDENCE;
  }
  return confidenceBucket(confidence) === "high";
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

/**
 * Whether one job's verdict clears it to stop blocking. Pure, for testing.
 *
 * `dispatch` is the latest dispatch row for the job's signal key. The verdict
 * must cover this run of the job (verdictCoversRun): it answers a dispatch made
 * after the run finished. A verdict keyed by (sha, job name) would otherwise
 * clear a rerun with the earlier run's answer, including one that lands after
 * the rerun finished. No dispatch row, a failed one, or one made before the
 * run all keep the job blocking.
 */
export function isSuppressible(
  job: RecentWorkflowsData,
  rows: AdvisorVerdictRow[],
  dispatch: DispatchMark | undefined
): boolean {
  // A PR-state gate keeps blocking whatever a verdict says. Dr.CI no longer
  // dispatches on these, but verdicts from earlier or manual dispatches exist.
  if (isExcludedFromAdvisor(job) || !producedATestOutcome(job)) {
    return false;
  }
  const resolved = resolveVerdict(rows);
  if (resolved === null) {
    return false;
  }
  return (
    SUPPRESSIBLE_VERDICTS.has(resolved.verdict) &&
    confidentEnoughToSuppress(resolved.verdict, resolved.confidence) &&
    verdictCoversRun(
      resolved.timestamp,
      job.completed_at,
      dispatch,
      runJobId(job)
    )
  );
}

/**
 * Job ids among `jobs` that the advisor has cleared. Returns an empty set when
 * the flag is off, so the caller needs no separate check.
 *
 * Takes the PR's verdict rows and dispatch states rather than reading them:
 * drci.ts reads each once and shares them with the badge line, so the two
 * cannot resolve the same job to different verdicts or disagree on whether the
 * verdict covers this run. They can still reach different DISPOSITIONS -- the
 * gate adds the confidence and conclusion tests the badge does not, so a
 * confident-looking badge beside a still-blocking job is expected. Rows for any
 * other commit are dropped here, so a verdict from an earlier head can never
 * clear a job at this one.
 */
export function suppressibleJobIds(
  owner: string,
  repo: string,
  headSha: string,
  jobs: RecentWorkflowsData[],
  verdictRows: AdvisorVerdictRow[],
  dispatchByKey: Map<string, DispatchMark>
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
    const key = drciSignalKeyForJob(job.name);
    if (isSuppressible(job, rowsByKey.get(key) ?? [], dispatchByKey.get(key))) {
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
