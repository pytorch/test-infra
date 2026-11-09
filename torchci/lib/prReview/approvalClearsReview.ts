// A human approval that satisfies merge_rules.yaml stops the automated review
// from blocking what it covers. A standing change request is dismissed, with
// its findings still shown, when such an approval was given on the head or on
// the request's own commit, so Dr.CI reports the PR approved. Checked when such
// an approval arrives and when the automated review requests changes. A request
// on a commit after the approval stays; when an approval arrives and one does,
// the review re-runs, and pytorch/pytorch's scripts/pr_review/post_review.py
// then blocks only on the changes since the approved commit.

import { isAutomatedReviewRequest } from "lib/bot/pytorchBotHandler";
import { isPyTorchPyTorch } from "lib/bot/utils";
import { isBot } from "lib/greenlight/greenlightReviewGate";
import {
  bindingApprovalCommits,
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
  const approved = await bindingApprovalCommits(
    octokit as any,
    owner,
    repo,
    pr.number,
    reviews as any
  );
  if (approved.size === 0) {
    return;
  }
  // Live state: the webhook can predate a push or a label change.
  const live = (
    await octokit.pulls.get({ owner, repo, pull_number: pr.number })
  ).data;
  const covered = (r: { commit_id: string | null }) =>
    approved.has(live.head.sha) ||
    (r.commit_id !== null && approved.has(r.commit_id));
  const cleared = standing.filter(covered);

  // A failed re-run still dismisses what the approval covers.
  if (approval && cleared.length < standing.length) {
    try {
      await reReview(context, live);
    } catch (error) {
      context.log.error(
        `Could not re-run the automated review of ${owner}/${repo}#${pr.number}: ${error}`
      );
    }
  }
  for (const r of cleared) {
    await octokit.pulls.dismissReview({
      owner,
      repo,
      pull_number: pr.number,
      review_id: r.id,
      message: APPROVED_DISMISSAL,
    });
  }
}

// Re-runs the automated review, if hardened-pr-review.yml would review the
// PR, so that it reviews the head knowing about the approval.
async function reReview(
  context: Context<"pull_request_review.submitted">,
  live: {
    state: string;
    draft?: boolean;
    labels: { name: string }[];
  }
) {
  const { owner, repo } = context.repo();
  const pullNumber = context.payload.pull_request.number;
  const labels = live.labels.map((label) => label.name);
  const reviewable =
    live.state === "open" &&
    !live.draft &&
    labels.includes(PR_STATUS_LABEL_IN_PROGRESS) &&
    !labels.includes(PR_STATUS_LABEL_READY_FOR_REVIEW) &&
    !labels.includes(PR_STATUS_LABEL_REVIEW_OPT_OUT);
  if (!reviewable) {
    return;
  }
  context.log(
    `Re-running the automated review of ${owner}/${repo}#${pullNumber}: an approval does not cover its change request`
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
