// A human approval that satisfies merge_rules.yaml stops the automated review
// from blocking: its standing change requests are dismissed, with their
// findings still shown, so Dr.CI reports the PR approved. Checked when such an
// approval arrives and when the automated review requests changes after one.
// An approval when the request predates the head also re-runs the review, and
// pytorch/pytorch's scripts/pr_review/post_review.py posts that verdict as a
// comment because the PR is approved.

import { isAutomatedReviewRequest } from "lib/bot/pytorchBotHandler";
import { isPyTorchPyTorch } from "lib/bot/utils";
import { isBot } from "lib/greenlight/greenlightReviewGate";
import {
  hasBindingHumanApproval,
  PR_STATUS_LABEL_IN_PROGRESS,
  PR_STATUS_LABEL_READY_FOR_REVIEW,
  PR_STATUS_LABEL_REVIEW_OPT_OUT,
} from "lib/prStatus";
import { Context, Probot } from "probot";

export const APPROVED_DISMISSAL =
  "Dismissed: an approval satisfies merge_rules.yaml, so the automated review " +
  "no longer blocks merging. Its findings are still shown above.";

async function handle(context: Context<"pull_request_review.submitted">) {
  const owner = context.payload.repository.owner.login;
  const repo = context.payload.repository.name;
  const { review, pull_request: pr } = context.payload;
  if (!isPyTorchPyTorch(owner, repo) || pr.state !== "open") {
    return;
  }
  const approval =
    review.state.toLowerCase() === "approved" &&
    !isBot(review.user?.login ?? "", review.user?.type);
  if (!approval && !isAutomatedReviewRequest(review)) {
    return;
  }

  const octokit = context.octokit;
  const reviews = await octokit.paginate(octokit.pulls.listReviews, {
    owner,
    repo,
    pull_number: pr.number,
    per_page: 100,
  });
  const standing = reviews.filter(isAutomatedReviewRequest);
  if (standing.length === 0) {
    return;
  }
  if (
    !(await hasBindingHumanApproval(
      octokit as any,
      owner,
      repo,
      pr.number,
      reviews as any
    ))
  ) {
    return;
  }

  // A failed re-run still dismisses: the approval alone unblocks the PR.
  if (approval) {
    try {
      await reReviewIfStale(context, standing);
    } catch (error) {
      context.log.error(
        `Could not re-run the automated review of ${owner}/${repo}#${pr.number}: ${error}`
      );
    }
  }
  for (const r of standing) {
    await octokit.pulls.dismissReview({
      owner,
      repo,
      pull_number: pr.number,
      review_id: r.id,
      message: APPROVED_DISMISSAL,
    });
  }
}

// Re-runs the automated review when a request it made predates the head and
// hardened-pr-review.yml would review the PR.
async function reReviewIfStale(
  context: Context<"pull_request_review.submitted">,
  standing: { commit_id: string | null }[]
) {
  const { owner, repo } = context.repo();
  const pullNumber = context.payload.pull_request.number;
  // Live state: the webhook can predate a push or a label change.
  const live = (
    await context.octokit.pulls.get({ owner, repo, pull_number: pullNumber })
  ).data;
  const labels = live.labels.map((label) => label.name);
  const reviewable =
    live.state === "open" &&
    !live.draft &&
    labels.includes(PR_STATUS_LABEL_IN_PROGRESS) &&
    !labels.includes(PR_STATUS_LABEL_READY_FOR_REVIEW) &&
    !labels.includes(PR_STATUS_LABEL_REVIEW_OPT_OUT);
  if (!reviewable || standing.every((r) => r.commit_id === live.head.sha)) {
    return;
  }
  context.log(
    `Re-running the automated review of ${owner}/${repo}#${pullNumber}: approved since its change request`
  );
  // Remove before add, so the review workflow sees a fresh `labeled`.
  await context.octokit.issues.removeLabel(
    context.issue({ name: PR_STATUS_LABEL_IN_PROGRESS })
  );
  await context.octokit.issues.addLabels(
    context.issue({ labels: [PR_STATUS_LABEL_IN_PROGRESS] })
  );
}

export default function approvalClearsReview(app: Probot): void {
  app.on("pull_request_review.submitted", handle);
}
