// A human approval that satisfies merge_rules.yaml stops the automated review
// from blocking. If its change request is on the current head, the request is
// dismissed at once and its findings stay shown. Otherwise the review re-runs,
// and pytorch/pytorch's scripts/pr_review/post_review.py posts the new verdict
// as a comment because the PR is approved.

import { isBot } from "lib/greenlight/greenlightReviewGate";
import {
  hasMergeRuleApproval,
  PR_STATUS_LABEL_IN_PROGRESS,
  PR_STATUS_LABEL_READY_FOR_REVIEW,
  PR_STATUS_LABEL_REVIEW_OPT_OUT,
} from "lib/prStatus";
import { getApprovingReviewers } from "lib/reviewApproval";
import { Context, Probot } from "probot";
import { AUTOMATED_REVIEWER_LOGIN } from "./pytorchBotHandler";
import { isPyTorchPyTorch } from "./utils";

// The first line of every review post_review.py posts.
const REVIEW_MARKER = "<!-- hardened-pr-review -->";

export const APPROVED_DISMISSAL =
  "Dismissed: an approval satisfies merge_rules.yaml, so the automated review " +
  "no longer blocks merging. Its findings are still shown above.";

async function handle(context: Context<"pull_request_review.submitted">) {
  const owner = context.payload.repository.owner.login;
  const repo = context.payload.repository.name;
  const { review, pull_request: pr } = context.payload;
  if (
    !isPyTorchPyTorch(owner, repo) ||
    pr.state !== "open" ||
    review.state.toLowerCase() !== "approved" ||
    isBot(review.user?.login ?? "", review.user?.type)
  ) {
    return;
  }

  const octokit = context.octokit;
  const reviews = await octokit.paginate(octokit.pulls.listReviews, {
    owner,
    repo,
    pull_number: pr.number,
    per_page: 100,
  });
  const standing = reviews.filter(
    (r) =>
      r.user?.login === AUTOMATED_REVIEWER_LOGIN &&
      r.state === "CHANGES_REQUESTED" &&
      (r.body ?? "").startsWith(REVIEW_MARKER)
  );
  if (standing.length === 0) {
    return;
  }
  const humans = getApprovingReviewers(reviews as any, true).filter(
    (login) => !isBot(login, undefined)
  );
  if (
    humans.length === 0 ||
    !(await hasMergeRuleApproval(
      octokit as any,
      owner,
      repo,
      pr.number,
      humans
    ))
  ) {
    return;
  }

  // Live state: the webhook can predate a push or a label change.
  const live = (
    await octokit.pulls.get({ owner, repo, pull_number: pr.number })
  ).data;
  if (live.state !== "open") {
    return;
  }
  const labels = live.labels.map((label) => label.name);
  // The conditions under which hardened-pr-review.yml reviews a labeled PR.
  const reviewable =
    !live.draft &&
    labels.includes(PR_STATUS_LABEL_IN_PROGRESS) &&
    !labels.includes(PR_STATUS_LABEL_READY_FOR_REVIEW) &&
    !labels.includes(PR_STATUS_LABEL_REVIEW_OPT_OUT);
  if (reviewable && standing.some((r) => r.commit_id !== live.head.sha)) {
    context.log(
      `Re-running the automated review of ${owner}/${repo}#${pr.number}: approved since its change request`
    );
    // Remove before add, so the review workflow sees a fresh `labeled`.
    await octokit.issues.removeLabel(
      context.issue({ name: PR_STATUS_LABEL_IN_PROGRESS })
    );
    await octokit.issues.addLabels(
      context.issue({ labels: [PR_STATUS_LABEL_IN_PROGRESS] })
    );
    return;
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

export default function approvalReReviewBot(app: Probot): void {
  app.on("pull_request_review.submitted", handle);
}
