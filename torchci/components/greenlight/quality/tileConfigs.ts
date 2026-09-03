// Label, figure and caveat text for every tile on the GreenLight Quality page.

import { intFormatter } from "components/common/numberFormat";
import { TileSize } from "components/greenlight/quality/QualityTile";
import {
  formatEffectiveWindow,
  hasCount,
  isEmptyWindow,
  pctOf,
  percentUnitsFormatter,
  RevertStats,
  secondsFormatter,
} from "lib/greenlight/qualityFigures";
import { LatencyRow } from "lib/greenlight/qualityQuery";

export interface StatTileConfig {
  key: string;
  label: string;
  size?: TileSize;
  value: (_row: any) => string;
  caveat?: (_row: any) => string;
  isEmpty?: (_row: any) => boolean;
}

export const COVERAGE_TILES: StatTileConfig[] = [
  {
    key: "prs_evaluated",
    label: "PRs evaluated",
    value: (row) => intFormatter(row?.prs_evaluated),
    caveat: (row) =>
      `Distinct PRs carrying any non-REVERTED ledger event, which includes PRs GreenLight dispatched but never returned a verdict for. ${intFormatter(
        row?.prs_with_verdict
      )} reached a verdict.`,
    isEmpty: (row) => !hasCount(row?.prs_evaluated),
  },
  {
    key: "verdicts_total",
    label: "Verdicts",
    value: (row) => intFormatter(row?.verdicts_total),
    caveat: (row) =>
      `Raw emitted LAND/NO_LAND rows, so a verdict GreenLight published twice is counted twice. They cover ${intFormatter(
        row?.verdicts_distinct_pr_sha
      )} distinct (PR, head SHA) pairs. ${intFormatter(
        row?.cancelled_failed
      )} cancelled/failed runs excluded.`,
    isEmpty: (row) => !hasCount(row?.verdicts_total),
  },
  {
    key: "verdict_split",
    label: "LAND / NO_LAND",
    value: (row) =>
      `${intFormatter(row?.land_verdicts)} / ${intFormatter(
        row?.no_land_verdicts
      )}`,
    caveat: (row) =>
      `${percentUnitsFormatter(
        pctOf(row?.land_verdicts, row?.verdicts_total)
      )} of verdicts are LAND. A LAND verdict is not a merge — it is permission to merge.`,
    isEmpty: (row) => !hasCount(row?.verdicts_total),
  },
  {
    key: "effective_window",
    label: "Effective window",
    size: "small",
    // Deliberately not gated on isEmpty: when the window selects nothing, this
    // tile's caveat is the explanation of why every other tile is blank.
    value: (row) => formatEffectiveWindow(row),
    caveat: (row) =>
      isEmptyWindow(row)
        ? "The requested range ends before the ledger begins, so the clamp leaves nothing to measure. Move the range forward to the ledger's span."
        : "Clamped to the ledger's span. Widening the picker past the ledger start does not widen this, so every rate on the page shares this denominator window.",
  },
];

// A PR is certain to be shown the in-progress state only if its dispatch->verdict
// phase outlives a whole Dr. CI render period, since the render runs on a cron of
// its own and nothing is posted at dispatch. Whether a shorter phase is caught
// depends on where a render happens to fall inside it, so this share is a floor
// on visibility, not an estimate of it.
// Carries its own denominator, because it does not share the tile's. The tile's n
// counts head SHAs on the dispatch clock; this share is over review cycles, a
// different population — printing a bare percentage next to `n=` invites it being
// read as that many of those.
export function firstFeedbackVisibility(row: any): string | undefined {
  const certain = pctOf(row?.n_review_over_threshold, row?.n_review);
  if (certain === undefined) {
    return undefined;
  }
  return `${percentUnitsFormatter(certain)} of ${intFormatter(
    row?.n_review
  )} review cycles certain to see it`;
}

// The four field names are the page's only reads that go through indirection, and
// so the only ones a diff reviewer cannot see as a column reference. keyof makes a
// mistyped one a compile error.
export interface LatencyTileConfig {
  key: string;
  label: string;
  nField: keyof LatencyRow;
  p50Field: keyof LatencyRow;
  withinField: keyof LatencyRow;
  cutoffField: keyof LatencyRow;
  subNote?: (_row: any) => string | undefined;
  caveat: (_row: any) => string;
}

// Two independent clocks over two different populations, not a decomposition of
// one another. Each shows a median and the share of its observations finishing
// inside a fixed cutoff; the cutoff is read from the query rather than named in
// prose, so changing it server-side cannot leave a stale duration on the page.
export const LATENCY_TILES: LatencyTileConfig[] = [
  {
    key: "end_to_end",
    label: "End-to-end: commit → verdict",
    nField: "n_end_to_end",
    p50Field: "e2e_p50_s",
    withinField: "n_e2e_within_cutoff",
    cutoffField: "e2e_cutoff_s",
    caveat: (row) =>
      `Anchored on the commit's authored timestamp, not on push receipt. GreenLight's bootstrap pass over PRs that were already open therefore measures how old those commits were rather than how long anyone waited, and a commit held in a local branch or an unpushed stack counts against it the same way — both stretch the tail without touching the middle. Head SHAs excluded from one or both of the push-anchored clocks — these are shared counts, not this tile's alone, and do not subtract from any single n on the page: ${intFormatter(
        row?.excluded_no_push_ts
      )} with no push timestamp, ${intFormatter(
        row?.excluded_push_after_event
      )} whose timestamp falls after the event it anchors, ${intFormatter(
        row?.excluded_pre_ledger
      )} predating the ledger.`,
  },
  {
    key: "first_feedback",
    label: "First feedback: commit → GreenLight starts",
    nField: "n_dispatch",
    p50Field: "dispatch_p50_s",
    withinField: "n_dispatch_within_cutoff",
    cutoffField: "dispatch_cutoff_s",
    subNote: firstFeedbackVisibility,
    // The render period is read from its column rather than written here, for
    // the same drift reason as the cutoffs: it is the sole input to the share on
    // the tile face. Its value tracks the Dr. CI comment-refresh cron in
    // .github/workflows/update-drci-comments.yml, which owns the schedule.
    caveat: (row) =>
      `Dispatch is the first sign to an author that GreenLight is on the PR, but nothing is posted when it happens: Dr. CI repaints the in-progress state on a cron of its own, so most PRs go straight from nothing to a final verdict. Only a review outliving a full repaint interval is certain to be caught — ${intFormatter(
        row?.n_review_over_threshold
      )} of ${intFormatter(
        row?.n_review
      )} review cycles do. That interval is ${secondsFormatter(
        row?.review_visible_after_s
      )}. Shares the commit-authored-time anchor, and the exclusions, of the end-to-end clock.`,
  },
];

// Two shares over the same review-run grain: one counts the runs that ended
// badly, one the runs that ended slowly. Both read a numerator and its own
// denominator off the query rather than dividing here, and both name that
// denominator on the face — they do not share one, so a bare percentage would
// leave no way to tell which population each was taken over.
export interface ReviewRunTileConfig {
  key: string;
  label: string;
  countField: keyof LatencyRow;
  nField: keyof LatencyRow;
  subNote?: (_row: any) => string | undefined;
  caveat: (_row: any) => string;
}

export function reviewRuntimeCutoff(row: any): string | undefined {
  return hasCount(row?.review_runtime_cutoff_s)
    ? `over ${secondsFormatter(row?.review_runtime_cutoff_s)}`
    : undefined;
}

export const REVIEW_RUN_TILES: ReviewRunTileConfig[] = [
  {
    key: "runs_failed",
    label: "Review CI runs that failed",
    countField: "n_review_runs_failed",
    nField: "n_review_runs",
    caveat: (row) =>
      `A run that ended FAILED and never went on to a verdict. Cancelled runs are not failures and are not counted here: the reviewer workflow runs in a singleton concurrency group, so a newer dispatch supersedes an in-flight run by design. They stay in the denominator, because CI did attempt them. A run that failed an attempt and then reached a verdict is a verdict, not a failure, and the count is per run rather than per FAILED row — a run that keeps failing is re-emitted on every retry. Runs still in flight are in neither the numerator nor the denominator, so a window ending mid-review reports slightly fewer runs than it dispatched. Denominator is review cycles that reached a terminal status in the window, a wider population than the ${intFormatter(
        row?.n_review
      )} on the latency clocks above.`,
  },
  {
    key: "runs_over_runtime",
    label: "Review CI runs that overran",
    countField: "n_review_runs_over_runtime",
    nField: "n_review_runs_timed",
    subNote: reviewRuntimeCutoff,
    caveat: (row) =>
      `Measured from the ledger's AI_REVIEW_STARTED — or from AI_REVIEW_DISPATCHED where no start was written — to whichever terminal status the run reached, so a cancelled or failed run counts its own duration rather than being dropped. This is the ledger's view of the run and not the GitHub Actions job duration — nothing joins the workflow tables — so any gap between the job's clock and the ledger's writes lands inside this figure. Carries its own denominator: of the ${intFormatter(
        row?.n_review_runs
      )} runs that reached a terminal status, ${intFormatter(
        row?.n_review_runs_timed
      )} recorded a start to measure from. The rest recorded neither a start nor a dispatch, and counting a run with no clock would score it as a fast one. The cutoff is a reporting threshold, not a timeout anything enforces.`,
  },
];

export function mergeAuthorityValue(row: any): string {
  return `${percentUnitsFormatter(row?.pct_gl_only)} · ${percentUnitsFormatter(
    row?.pct_of_all_merges
  )}`;
}

export function mergeAuthoritySub(row: any): string {
  return `${intFormatter(row?.gl_only)} / ${intFormatter(
    row?.merged_evaluated_prs
  )} of evaluated merges · ${intFormatter(row?.gl_only)} / ${intFormatter(
    row?.merged_prs_total
  )} of all merges`;
}

export function mergeAuthorityCaveat(row: any): string {
  return `Two denominators, because the narrow one on its own reads as “GreenLight authorises this share of the repo”. Human-approved: ${intFormatter(
    row?.human_approved
  )} · no approval recorded: ${intFormatter(
    row?.no_approval
  )}. Approval detection is timestamp-based and errs in both directions: any non-rule approval from any GitHub user makes a PR look human-approved, while an approval landing seconds after the merge commit's timestamp is missed and the PR looks GreenLight-only.`;
}

export const REVERT_RATE_LABEL =
  "GreenLight-approved reverts, share of evaluated PRs";

export function revertRateValue(stats: RevertStats): string {
  return percentUnitsFormatter(stats.rate);
}

// The ghfirst exclusion belongs on the face, not only behind the affordance. Every
// approved revert in a window can be ghfirst, and then the value reads 0.0% with
// approved reverts listed directly beneath it — a reader who never hovers would take
// that as nothing having been reverted.
//
// Which count to show depends on whether the exclusion is hiding anything from the
// rate. Approved reverts removed by it are what reconciles a zero against a table that
// is not empty, so they are named when there are any; where the exclusion touched no
// approved revert the rate hides nothing, and the bare ghfirst total is the honest
// disclosure rather than a figure implying the headline is understated.
export function revertRateExclusion(stats: RevertStats): string {
  if (hasCount(stats.landApprovedGhfirst)) {
    return ` · ${intFormatter(
      stats.landApprovedGhfirst
    )} approved reverts excluded as ghfirst`;
  }
  return hasCount(stats.ghfirst)
    ? ` · ${intFormatter(stats.ghfirst)} ghfirst excluded`
    : "";
}

export function revertRateSub(stats: RevertStats): string {
  const unattributable =
    stats.unattributable === undefined
      ? "unattributable count unavailable"
      : `${intFormatter(stats.unattributable)} unattributable`;
  return `${intFormatter(stats.landApproved)} / ${intFormatter(
    stats.evaluatedPrs
  )} evaluated PRs · ${unattributable}${revertRateExclusion(stats)}`;
}

// coverageRow is optional on purpose: it supplies only the window string, and a
// coverage failure must not take down a figure computed entirely from reverts.
// The ghfirst count is named rather than left implicit: an exclusion nobody
// states is indistinguishable from the reverts not having happened. It also
// points at the table, because the rate and the table deliberately cover
// different populations and a reader who spots that needs the reason.
export function revertRateCaveat(stats: RevertStats, coverageRow: any): string {
  const window =
    coverageRow === undefined || isEmptyWindow(coverageRow)
      ? ""
      : ` (${formatEffectiveWindow(coverageRow)})`;
  const approvedGhfirst = hasCount(stats.landApprovedGhfirst)
    ? ` ${intFormatter(
        stats.landApprovedGhfirst
      )} of them were reverts of a version GreenLight had approved, which is why this rate can read zero while the table below is not empty.`
    : " None of them were reverts of a version GreenLight had approved, so excluding them moved this rate by nothing.";
  const ghfirst = hasCount(stats.ghfirst)
    ? ` A further ${intFormatter(
        stats.ghfirst
      )} carry a ghfirst classification and are excluded from this rate: such a revert is forced by the internal-first landing path rather than by anything visible in the diff, so scoring one against a verdict would measure the landing path instead of the verdict.${approvedGhfirst} The table below holds only reverts of a version GreenLight approved, so a ghfirst revert appears there when it is one of those and not otherwise. Where one does appear it carries its classification beside the reverter's own message, so the cause can be followed rather than taken on trust.`
    : "";
  return `Denominator is every PR GreenLight evaluated in the window${window} — the same count the coverage strip reports — including PRs that never merged and so could never be reverted, which makes this a floor rather than a per-merge risk. The numerator counts revert commits, not PRs, so a PR reverted twice counts twice. The window held ${intFormatter(
    stats.resolvable
  )} reverts that resolve to a PR at all; ${intFormatter(
    stats.total
  )} of those survive the ghfirst exclusion this rate applies, and ${intFormatter(
    stats.evaluated
  )} of those were GreenLight-evaluated. Unattributable reverts could not be resolved back to a PR and are excluded from the numerator.${ghfirst}`;
}
