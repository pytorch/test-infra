import { getRotatingBatch } from "lib/bot/preReviewUtils";
import { queryClickhouseSaved } from "lib/clickhouse";
import {
  DRCI_COMMENT_AUTHOR,
  DRCI_COMMENT_START,
  upsertPrStatusSection,
} from "lib/drciUtils";
import {
  fetchPrStatusState,
  PR_STATUS_LABELS,
  PR_STATUS_START,
  PRE_REVIEW_START_DATE,
} from "lib/prStatus";
import { Octokit } from "octokit";
import pLimit from "p-limit";

const MAX_PRS_PER_RUN = 100;
const RUN_INTERVAL_MS = 15 * 60 * 1000;

export interface PrStatusSweepResult {
  checked: number;
  failed: number[];
}

// Recover missed webhooks, quiet later phases, and PRs with no Dr.CI comment.
// This only reconciles comments.
export async function refreshPrStatusComments(
  reader: Octokit,
  writer: Octokit,
  owner: string,
  repo: string,
  now: number = Date.now()
): Promise<PrStatusSweepResult> {
  const results: { number: number }[] = await queryClickhouseSaved(
    "pr_status_sweep_candidates",
    {
      repo: `${owner}/${repo}`,
      preReviewStartDate: PRE_REVIEW_START_DATE,
      workflowLabels: PR_STATUS_LABELS,
      drciCommentAuthor: DRCI_COMMENT_AUTHOR,
      drciCommentStart: DRCI_COMMENT_START,
      prStatusStart: PR_STATUS_START,
    }
  );
  // Stable numeric order keeps changing query order and duplicate matches
  // from repeatedly consuming the same slots in the stateless rotation.
  const candidates = [
    ...new Map(results.map((pr) => [pr.number, pr])).values(),
  ].sort((a, b) => a.number - b.number);
  const batch = getRotatingBatch(
    candidates,
    Math.floor(now / RUN_INTERVAL_MS),
    MAX_PRS_PER_RUN
  );
  const failed = new Set<number>();
  const limit = pLimit(5);
  await Promise.all(
    batch.map((pr) =>
      limit(async () => {
        try {
          const state = await fetchPrStatusState(
            reader,
            owner,
            repo,
            pr.number,
            // Unlabeled PRs can have stale status from a missed label-removal
            // webhook. Always force live metadata reads: the mirror only
            // selects candidates; these labels are never rendered on failure.
            PR_STATUS_LABELS
          );
          if (!state || state.reviewerLookupFailed) {
            failed.add(pr.number);
            return;
          }
          if (state.pullRequest?.state === "closed") {
            return;
          }
          if (state.mergeApprovalLookupFailed) {
            failed.add(pr.number);
          }
          await upsertPrStatusSection(
            writer,
            owner,
            repo,
            pr.number,
            state.labels,
            state.authorLogin,
            { reader, state, createIfMissing: true }
          );
        } catch (error) {
          failed.add(pr.number);
          console.error(
            `Failed to refresh PR status for ${owner}/${repo}#${pr.number}`,
            error
          );
        }
      })
    )
  );
  return { checked: batch.length, failed: [...failed].sort((a, b) => a - b) };
}
