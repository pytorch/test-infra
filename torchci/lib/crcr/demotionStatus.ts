import {
  buildDemotionRows,
  CriterionRow,
  L3Metrics,
  L3SummaryRow,
  useL3SummaryMap,
} from "lib/crcr/l3Readiness";
import { L3_DEMOTION_WINDOW_DAYS } from "lib/crcr/l3Thresholds";
import { useMemo } from "react";

export interface RepoDemotionStatus {
  repo: string;
  /** Meets the demotion criteria over the window — lands on the page and files the PR. */
  onTemporaryDemotion: boolean;
  /** Criteria rows, so the page can show what is triggering. */
  rows: CriterionRow[];
}

function isViolating(metrics: L3Metrics | null): boolean {
  if (!metrics) return false;
  // `verdict === false` is "fails the criterion"; null means no data to judge,
  // which is deliberately not a violation.
  return buildDemotionRows(metrics).some((r) => r.verdict === false);
}

/**
 * Per-repo demotion status over the single L3_DEMOTION_WINDOW_DAYS window.
 *
 * A violation here both lists the repo under "L3 Temporary Demotion" and
 * files the L3 -> L2 PR — there is no separate, longer confirmation window.
 * Auto-filing a PR isn't the same as merging one: a human still reviews it,
 * so a repo that recovers right after a bad week just gets its PR closed
 * rather than being stuck waiting for stale data to age out of an aggregate.
 */
export function buildDemotionStatuses(
  metricsMap: Map<string, L3SummaryRow>
): RepoDemotionStatus[] {
  const statuses: RepoDemotionStatus[] = [];
  for (const [repo, metrics] of metricsMap) {
    statuses.push({
      repo,
      onTemporaryDemotion: isViolating(metrics),
      rows: buildDemotionRows(metrics),
    });
  }
  return statuses;
}

export function useDemotionStatuses() {
  const { map, loaded, error } = useL3SummaryMap(L3_DEMOTION_WINDOW_DAYS);
  const statuses = useMemo(() => buildDemotionStatuses(map), [map]);
  return { statuses, loaded, error };
}
