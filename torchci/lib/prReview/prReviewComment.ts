// Server-side glue for the automated PR review section of the Dr.CI comment.
// Reads the latest misc.pr_review_verdicts row for every PR in a Dr.CI sweep in
// one batched query, then delegates the (pure) rendering to prReviewRender.ts.

import { queryClickhouseSaved } from "lib/clickhouse";
import {
  PrReviewRow,
  renderPrReviewSection,
} from "lib/prReview/prReviewRender";

// Repos whose automated review verdicts are rendered into the Dr.CI comment.
// Folded to lower case at construction, like the key below, so an entry in any
// spelling matches.
export const PR_REVIEW_REPOS: string[] = ["pytorch/pytorch"].map((name) =>
  name.trim().toLowerCase()
);

export function prReviewRepoKey(owner: string, repo: string): string {
  return `${owner}/${repo}`.trim().toLowerCase();
}

/**
 * Build the automated review section for every PR in a Dr.CI sweep.
 * Takes pr_number -> the PR's head sha at sweep time. Returns pr_number ->
 * rendered markdown, omitting PRs with no review row, rows that render to
 * nothing, and rows whose render threw. Issues no query when the repo is not
 * enabled or no PRs were passed. The caller wraps this so a ClickHouse error can
 * never break the Dr.CI comment.
 */
export async function buildPrReviewSections(
  owner: string,
  repo: string,
  headShaByPr: Map<number, string>
): Promise<Map<number, string>> {
  const sections = new Map<number, string>();
  const prNumbers = Array.from(headShaByPr.keys());
  const repoKey = prReviewRepoKey(owner, repo);
  if (!PR_REVIEW_REPOS.includes(repoKey) || prNumbers.length === 0) {
    return sections;
  }

  const rows = (await queryClickhouseSaved("pr_review_verdicts_for_prs", {
    repo: repoKey,
    prNumbers,
  })) as PrReviewRow[];

  const now = new Date();
  for (const row of rows) {
    // Per row, so one bad row cannot strip the section off every other PR. The
    // log gets the PR number and the error, never the row: it holds model output.
    try {
      const rendered = renderPrReviewSection(
        row,
        repoKey,
        now,
        headShaByPr.get(Number(row.pr_number)) ?? ""
      );
      if (rendered) {
        sections.set(Number(row.pr_number), rendered);
      }
    } catch (e) {
      console.error("pr review section render threw for PR", row.pr_number, e);
    }
  }
  return sections;
}
