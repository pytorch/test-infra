import { isPyTorchPyTorch } from "lib/bot/utils";
import {
  hasPendingTriageLabels,
  isPrStatusEligible,
  PR_STATUS_LABEL_IN_PROGRESS,
} from "lib/prStatus";
import { Octokit } from "octokit";

// Coalesce concurrent deliveries in this process. A later delivery always reads
// live state again, including after a failed or partially successful label write.
const promotions = new Map<string, Promise<boolean>>();

/**
 * Advance eligible triaged PRs directly, regardless of human/merge approval or
 * reviewer assignments or responses. Only PyTorchBot writes the label: that identity
 * triggers automated review. The resulting label event refreshes Dr.CI status.
 */
export async function markTriagedInProgress(
  reader: Octokit,
  labeler: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<boolean> {
  if (!isPyTorchPyTorch(owner, repo)) return false;
  const key = `${owner}/${repo}#${prNumber}`;
  const pending = promotions.get(key);
  if (pending) return pending;

  const promotion = (async () => {
    // Webhook snapshots and search results may predate drafts, holds, closure,
    // or another promotion. Never re-add a later-stage label on replay.
    const { data: pr } = await reader.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });
    if (
      !isPrStatusEligible(pr) ||
      !hasPendingTriageLabels(pr.labels.map((label) => label.name))
    ) {
      return false;
    }
    await labeler.rest.issues.addLabels({
      owner,
      repo,
      issue_number: prNumber,
      labels: [PR_STATUS_LABEL_IN_PROGRESS],
    });
    return true;
  })();
  promotions.set(key, promotion);
  try {
    return await promotion;
  } finally {
    promotions.delete(key);
  }
}
