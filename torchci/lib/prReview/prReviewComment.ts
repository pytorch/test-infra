// Server-side glue for the automated PR review section of the Dr.CI comment.
// Reads the latest misc.pr_review_verdicts row for every PR in a Dr.CI sweep in
// one batched query, then delegates the (pure) rendering to prReviewRender.ts.

import { queryClickhouseSaved } from "lib/clickhouse";
import {
  PrReviewRequest,
  PrReviewRow,
  renderMissingPrReview,
  renderPrReviewSection,
  timestampMs,
} from "lib/prReview/prReviewRender";
import {
  PR_STATUS_LABEL_IN_PROGRESS,
  PR_STATUS_LABEL_READY_FOR_REVIEW,
  PR_STATUS_LABEL_REVIEW_OPT_OUT,
} from "lib/prStatus";
import { RecentWorkflowsData } from "lib/types";

export interface PrReviewSection {
  body: string;
  missingRequest?: boolean;
}

export function prReviewSectionForLabels(
  section: PrReviewSection | undefined,
  labels: string[]
): string {
  // Capture also handles opt-out withdrawals, which intentionally write no
  // telemetry. Only show missing-status notices while review is enabled and
  // still expected. Re-enabling it may need a new trigger, hence the retry hint.
  if (
    section?.missingRequest &&
    (!labels.includes(PR_STATUS_LABEL_IN_PROGRESS) ||
      labels.includes(PR_STATUS_LABEL_READY_FOR_REVIEW) ||
      labels.includes(PR_STATUS_LABEL_REVIEW_OPT_OUT))
  ) {
    return "";
  }
  return section?.body ?? "";
}

// Use the raw jobs, before Dr.CI discards older runs: an unrelated label can
// create a newer skipped capture and must not hide the real review request.
export function latestPrReviewRequests(
  repo: string,
  headShaByPr: Map<number, string>,
  workflows: RecentWorkflowsData[]
): Map<number, PrReviewRequest> {
  const requests = new Map<number, PrReviewRequest>();
  for (const job of workflows) {
    const runId = Number(job.workflowId);
    if (
      job.workflowPath !== ".github/workflows/hardened-pr-review.yml" ||
      job.workflowEvent !== "pull_request_target" ||
      job.jobName !== "capture" ||
      job.conclusion !== "success" ||
      job.prDraft ||
      !job.head_sha ||
      headShaByPr.get(Number(job.pr_number)) !== job.head_sha ||
      !Number.isSafeInteger(runId) ||
      runId <= 0 ||
      !job.html_url.startsWith(
        `https://github.com/${repo}/actions/runs/${runId}/job/`
      ) ||
      !Number.isFinite(timestampMs(job.completed_at))
    ) {
      continue;
    }
    const previous = requests.get(Number(job.pr_number));
    if (
      !previous ||
      timestampMs(job.completed_at) > timestampMs(previous.completedAt)
    ) {
      requests.set(Number(job.pr_number), {
        headSha: job.head_sha,
        runId,
        completedAt: job.completed_at,
      });
    }
  }
  return requests;
}

function coversRequest(row: PrReviewRow, request: PrReviewRequest): boolean {
  return (
    row.head_sha === request.headSha &&
    // A newer capture may not have reached the workflow mirror yet. Still
    // check time: rerunning an older capture preserves its smaller run id.
    Number(row.trigger_run_id) >= request.runId &&
    Number(row.started_at_ms) >= timestampMs(request.completedAt)
  );
}

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
 * rendered markdown, including a fallback when a successful capture has no
 * corresponding review row. Issues no query when the repo is not
 * enabled or no PRs were passed. The caller wraps this so a ClickHouse error can
 * never break the Dr.CI comment.
 */
export async function buildPrReviewSections(
  owner: string,
  repo: string,
  headShaByPr: Map<number, string>,
  workflows: RecentWorkflowsData[] = []
): Promise<Map<number, PrReviewSection>> {
  const sections = new Map<number, PrReviewSection>();
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
        sections.set(Number(row.pr_number), { body: rendered });
      }
    } catch (e) {
      console.error("pr review section render threw for PR", row.pr_number, e);
    }
  }
  // Only a successful telemetry read establishes absence. A query failure
  // propagates to the caller and must never fabricate failed reviews.
  const rowsByPr = new Map(rows.map((row) => [Number(row.pr_number), row]));
  for (const [prNumber, request] of latestPrReviewRequests(
    repoKey,
    headShaByPr,
    workflows
  )) {
    const row = rowsByPr.get(prNumber);
    if (!row || !coversRequest(row, request)) {
      sections.set(prNumber, {
        body: renderMissingPrReview(request, repoKey, now),
        missingRequest: true,
      });
    }
  }
  return sections;
}
