// Label, figure and caveat text for every tile on the GreenLight Quality page.
//
// A field name declared keyof a row interface is a read a diff reviewer cannot
// see as a column reference. keyof makes a mistyped one a compile error.

import { intFormatter } from "components/common/numberFormat";
import {
  hasCount,
  pctOf,
  percentUnitsFormatter,
  RevertStats,
  secondsFormatter,
} from "lib/greenlight/qualityFigures";
import { CoverageRow, LatencyRow } from "lib/greenlight/qualityQuery";

// Each tile carries a total with the LAND/NO_LAND split inline beside it, over a
// legend naming the two. The split sums to the total for verdicts but not for
// PRs: prs_land + prs_no_land is prs_with_verdict, and PRs dispatched without a
// ruling sit in the gap.
export interface StatTileConfig {
  key: string;
  label: string;
  totalField: keyof CoverageRow;
  landField: keyof CoverageRow;
  noLandField: keyof CoverageRow;
  subNote?: (_row: any) => string | undefined;
  caveat?: (_row: any) => string;
  isEmpty?: (_row: any) => boolean;
}

// The one thing the PRs tile's split cannot show. Named beside the legend rather
// than left to the caveat, because the Verdicts tile carries the identical
// grammar under the identical legend and does sum: a reader who checks the
// arithmetic there and finds it works will trust it here, and a gap of one or two
// then reads as a fault rather than as a category.
export function noVerdictGap(row: any): string | undefined {
  const gap = row?.prs_evaluated - row?.prs_with_verdict;
  return hasCount(gap) ? `${intFormatter(gap)} no verdict` : undefined;
}

export const COVERAGE_TILES: StatTileConfig[] = [
  {
    key: "prs_evaluated",
    label: "PRs evaluated",
    totalField: "prs_evaluated",
    landField: "prs_land",
    noLandField: "prs_no_land",
    subNote: noVerdictGap,
    caveat: () =>
      "Distinct PRs GreenLight recorded any activity for. Some were dispatched but never got a verdict, which is why the split can be smaller than the total.",
    isEmpty: (row) => !hasCount(row?.prs_evaluated),
  },
  {
    key: "verdicts_total",
    label: "Verdicts",
    totalField: "verdicts_total",
    landField: "land_verdicts",
    noLandField: "no_land_verdicts",
    caveat: () =>
      "Every LAND and NO_LAND row GreenLight emitted, so a verdict published twice counts twice. A LAND is permission to merge, not a merge.",
    isEmpty: (row) => !hasCount(row?.verdicts_total),
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
    caveat: () =>
      "Time from the commit's authored timestamp to GreenLight's verdict. Commits written long before GreenLight ever saw them stretch the slow end.",
  },
  {
    key: "first_feedback",
    label: "First feedback: commit → GreenLight starts",
    nField: "n_dispatch",
    p50Field: "dispatch_p50_s",
    withinField: "n_dispatch_within_cutoff",
    cutoffField: "dispatch_cutoff_s",
    subNote: firstFeedbackVisibility,
    caveat: () =>
      "Time from the commit to GreenLight starting work on it. Nothing is posted at that moment, so most authors see nothing until the final verdict.",
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
    label: "CI runs failed",
    countField: "n_review_runs_failed",
    nField: "n_review_runs",
    caveat: () =>
      "Review runs that ended in failure and never produced a verdict. Cancelled runs don't count as failures.",
  },
  {
    key: "runs_over_runtime",
    label: "CI runs >33m",
    countField: "n_review_runs_over_runtime",
    nField: "n_review_runs_timed",
    subNote: reviewRuntimeCutoff,
    caveat: () =>
      "Review runs that took longer than the cutoff. This is the ledger's own clock, not the GitHub Actions job duration, and only runs that recorded a start can be timed.",
  },
];

// A share and the fraction it was taken over, handed to the panel as two pieces
// rather than one finished string: the tile carries two of these over two
// different denominators, and colour is what pairs each percentage with its own.
export interface ShareFigure {
  pct: string;
  fraction: string;
}

export function mergeAuthorityShares(row: any): {
  evaluated: ShareFigure;
  allMerges: ShareFigure;
} {
  return {
    evaluated: {
      pct: percentUnitsFormatter(row?.pct_gl_only),
      fraction: `${intFormatter(row?.gl_only)} / ${intFormatter(
        row?.merged_evaluated_prs
      )} of evaluated merges`,
    },
    allMerges: {
      pct: percentUnitsFormatter(row?.pct_of_all_merges),
      fraction: `${intFormatter(row?.gl_only)} / ${intFormatter(
        row?.merged_prs_total
      )} of all merges`,
    },
  };
}

export const MERGE_AUTHORITY_CAVEAT =
  "Merges where GreenLight's approval was the only one on the PR. Approval " +
  "detection is timestamp-based, so it misses one that lands just after the merge.";

export const REVERT_RATE_LABEL = "GreenLight-approved reverts";

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
    return `${intFormatter(stats.landApprovedGhfirst)} excluded as ghfirst`;
  }
  return hasCount(stats.ghfirst)
    ? `${intFormatter(stats.ghfirst)} excluded as ghfirst`
    : "";
}

// The revert count is the numerator of the rate above it and takes that rate's
// colour, so it is handed over apart from the rest of the line. The exclusion is
// its own line and empty when nothing was excluded.
export function revertRateSub(stats: RevertStats): {
  count: string;
  rest: string;
  exclusion: string;
} {
  return {
    count: intFormatter(stats.landApproved),
    rest: ` / ${intFormatter(stats.evaluatedPrs)} PRs`,
    exclusion: revertRateExclusion(stats),
  };
}

export const REVERT_RATE_CAVEAT =
  "Reverts of a commit GreenLight had approved, over every PR it evaluated. " +
  "Most evaluated PRs never merged, so this is a floor, not a per-merge risk.";
