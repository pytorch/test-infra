import { getPreReviewStatus, getRotatingBatch } from "lib/bot/preReviewUtils";
import { upsertPrStatusSection } from "lib/drciUtils";
import { searchPullRequestsByCreatedAt } from "lib/githubSearch";
import {
  fetchPrStatusState,
  getPrStatusStage,
  hasPrStatusLabel,
  PR_STATUS_LABELS,
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
// This only reconciles comments; deadline advancement remains in its own sweep.
export async function refreshPrStatusComments(
  reader: Octokit,
  writer: Octokit,
  owner: string,
  repo: string,
  now: number = Date.now()
): Promise<PrStatusSweepResult> {
  const results = await searchPullRequestsByCreatedAt(
    reader,
    `repo:${owner}/${repo} is:pr is:open`,
    // Include unlabeled PRs to repair a missed removal of the last workflow
    // label. Later phases and drafts also predate the pre-review rollout.
    0,
    Math.floor(now / 1000)
  );
  // Stable numeric order keeps changing search order and duplicate matches
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
          const searchLabels = pr.labels.map((label) =>
            typeof label === "string" ? label : label.name ?? ""
          );
          const state = await fetchPrStatusState(
            reader,
            owner,
            repo,
            pr.number,
            // Unlabeled PRs can have stale status from a missed label-removal
            // webhook. Still force a live PR/closed-state read;
            // these fallback labels are never rendered if that read fails.
            hasPrStatusLabel(searchLabels) ? searchLabels : PR_STATUS_LABELS,
            pr.user?.login
          );
          if (!state || state.reviewerLookupFailed) {
            failed.add(pr.number);
            return;
          }
          if (state.pullRequest?.state === "closed") {
            return;
          }
          if (
            hasPrStatusLabel(state.labels) &&
            getPrStatusStage(state) === "preReview"
          ) {
            state.preReview = await getPreReviewStatus(
              reader,
              owner,
              repo,
              pr.number,
              state.labels,
              state.authorLogin ?? "",
              [],
              state,
              now
            );
            if (state.preReview.lookupFailed) {
              failed.add(pr.number);
              return;
            }
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
