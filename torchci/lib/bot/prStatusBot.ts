// Refreshes PR Status on label and review webhooks instead of waiting for the
// CI-driven sweep. Only that section changes, preserving existing CI results.

import { upsertPrStatusSection } from "lib/drciUtils";
import {
  hasPrStatusLabel,
  PR_STATUS_LABEL_IN_PROGRESS,
  PR_STATUS_LABEL_READY_FOR_REVIEW,
  PR_STATUS_LABEL_TRIAGED,
  PR_STATUS_LABELS,
} from "lib/prStatus";
import { PR_CHANGES_REQUESTED } from "lib/reviewApproval";
import { Context, Probot } from "probot";
import { isInPreReview, markInProgressIfAccepted } from "./preReviewUtils";
import { hasVerifiedHumanWritePermissions, isPyTorchPyTorch } from "./utils";

async function handle(
  context: Context<"pull_request" | "pull_request_review">
) {
  const owner = context.payload.repository.owner.login;
  const repo = context.payload.repository.name;
  // These labels are pytorch/pytorch policy; other Dr.CI repos may reuse them.
  if (!isPyTorchPyTorch(owner, repo)) {
    context.log(`${__filename} isn't enabled on ${owner}/${repo}`);
    return;
  }

  const pullRequest = context.payload.pull_request;
  if (pullRequest.state !== "open") {
    return;
  }

  let labels = pullRequest.labels.map((label) => label.name);

  // Ignore events that cannot change status before spending GitHub API calls.
  const payload = context.payload as any;
  if (
    (payload.action === "labeled" || payload.action === "unlabeled") &&
    payload.label
  ) {
    if (!PR_STATUS_LABELS.includes(payload.label.name)) {
      return;
    }
  } else if (
    payload.action === "review_requested" ||
    payload.action === "review_request_removed"
  ) {
    // Reviewer assignments only affect pre-review status.
    if (!labels.includes(PR_STATUS_LABEL_TRIAGED)) {
      return;
    }
  } else if (!hasPrStatusLabel(labels)) {
    // Reviews outside the workflow cannot change status. An unlabeled event
    // without label metadata cannot be identified as workflow-related.
    return;
  }

  // A maintainer requesting changes sends a ready PR back to in progress. The
  // labels move before any comment update so a failed update cannot skip the
  // move; the label webhooks it fires render the new status.
  if (
    payload.action === "submitted" &&
    payload.review?.state?.toLowerCase() === PR_CHANGES_REQUESTED &&
    labels.includes(PR_STATUS_LABEL_READY_FOR_REVIEW) &&
    (await hasVerifiedHumanWritePermissions(context, payload.review.user.login))
  ) {
    context.log(
      `Moving ${owner}/${repo}#${pullRequest.number} back to "${PR_STATUS_LABEL_IN_PROGRESS}", changes requested by ${payload.review.user.login}`
    );
    // Add before removing so the PR always carries a status label.
    await context.octokit.issues.addLabels(
      context.issue({ labels: [PR_STATUS_LABEL_IN_PROGRESS] })
    );
    await context.octokit.issues.removeLabel(
      context.issue({ name: PR_STATUS_LABEL_READY_FOR_REVIEW })
    );
    return;
  }

  // A label move fires one webhook per label change and they run concurrently,
  // each carrying a mid-move snapshot of the labels. Rendering from the live
  // labels narrows the window for a stale status to a handler that reads them
  // mid-move yet finishes last; the next CI sweep corrects that.
  if (payload.action === "labeled" || payload.action === "unlabeled") {
    labels = (
      await context.octokit.paginate(
        context.octokit.issues.listLabelsOnIssue,
        context.issue({ per_page: 100 })
      )
    ).map((label) => label.name);
  }

  await upsertPrStatusSection(
    context.octokit as any,
    owner,
    repo,
    pullRequest.number,
    labels,
    pullRequest.user?.login
  );

  // Removing a pending reviewer, or assigning one who already commented an
  // accept, can complete agreement without a reaction or accept command. This
  // runs after the upsert so the labeled webhook renders the newer status.
  if (
    (payload.action === "review_requested" ||
      payload.action === "review_request_removed") &&
    pullRequest.user?.login &&
    isInPreReview(pullRequest)
  ) {
    await markInProgressIfAccepted(
      context.octokit as any,
      owner,
      repo,
      pullRequest.number,
      labels,
      pullRequest.user.login
    );
  }
}

export default function prStatusBot(app: Probot): void {
  app.on(
    [
      "pull_request.labeled",
      "pull_request.unlabeled",
      // Reviewer requests affect pre-review status.
      "pull_request.review_requested",
      "pull_request.review_request_removed",
      // Submitted or dismissed reviews can change approval.
      "pull_request_review.submitted",
      "pull_request_review.dismissed",
    ],
    handle
  );
}
