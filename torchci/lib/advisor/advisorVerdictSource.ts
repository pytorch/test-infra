// The single read of a PR's advisor verdicts.
//
// Both consumers in the Dr.CI request -- the inline badge line and the
// suppression gate -- need the same rows for the same PR and head. Reading
// twice cost a ClickHouse round trip per PR and, worse, let a verdict landing
// between the two reads make the comment and the merge gate describe the same
// job differently. drci.ts reads once here and hands the rows to both.

import {
  advisorCommentEnabled,
  advisorSuppressionEnabled,
} from "lib/advisor/advisorFlags";
import { AdvisorVerdictRow } from "lib/advisorVerdictUtils";
import { queryClickhouseSaved } from "lib/clickhouse";
import { RecentWorkflowsData } from "lib/types";

/**
 * Whether this PR is worth a verdict read at all.
 *
 * Both consumers bail on an empty job list, so a PR with no new or
 * unclassified failures -- the common case -- must not cost a query. Each
 * consumer re-checks its own flag; this only decides whether to read.
 */
export function shouldReadAdvisorVerdicts(
  owner: string,
  repo: string,
  jobs: RecentWorkflowsData[]
): boolean {
  if (jobs.length === 0) {
    return false;
  }
  return (
    advisorCommentEnabled(owner, repo) || advisorSuppressionEnabled(owner, repo)
  );
}

export async function fetchAdvisorVerdictRows(
  owner: string,
  repo: string,
  prNumber: number
): Promise<AdvisorVerdictRow[]> {
  return (await queryClickhouseSaved("advisor_verdicts_for_pr", {
    repo: `${owner}/${repo}`,
    prNumber,
  })) as AdvisorVerdictRow[];
}
