import {
  buildDemotionRows,
  CriterionRow,
  L3Metrics,
  L3SummaryRow,
} from "lib/crcr/l3Readiness";

export interface RepoDemotionStatus {
  repo: string;
  /** Meets at least one demotion criterion, or reported no jobs at all. */
  onTemporaryDemotion: boolean;
  /** No jobs at all in the window -- on the list for silence, not a metric. */
  noData: boolean;
  /** Criteria rows, so the page can show what is triggering. */
  rows: CriterionRow[];
}

function isViolating(metrics: L3Metrics | null): boolean {
  if (!metrics) return false;
  // Demotion is triggered when any of the following conditions are
  // observed.
  return buildDemotionRows(metrics).some((r) => r.verdict === false);
}

/**
 * Per-repo demotion status over the single L3_DEMOTION_WINDOW_DAYS window.
 *
 * Display only: a violation here lists the repo under the /crcr temporary
 * demotion section.
 *
 * A repo with zero jobs in the window has no summary row, and iterating the
 * map alone would never see it. Such a repo is put on temporary demotion
 * too.
 */
export function buildDemotionStatuses(
  repos: string[],
  metricsMap: Map<string, L3SummaryRow> | null
): RepoDemotionStatus[] {
  return repos.map((repo) => {
    const metrics = metricsMap?.get(repo) ?? null;
    const noData = metricsMap !== null && metrics === null;
    return {
      repo,
      onTemporaryDemotion: noData || isViolating(metrics),
      noData,
      rows: buildDemotionRows(metrics),
    };
  });
}
