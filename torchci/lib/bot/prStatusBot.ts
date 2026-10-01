// Refreshes PR Status on label and review webhooks instead of waiting for the
// CI-driven sweep. Only that section changes, preserving existing CI results.

import { upsertPrStatusSection } from "lib/drciUtils";
import {
  fetchLiveLabels,
  hasPrStatusLabel,
  PR_STATUS_LABEL_IN_PROGRESS,
  PR_STATUS_LABEL_READY_FOR_REVIEW,
  PR_STATUS_LABEL_REVIEW_OPT_OUT,
  PR_STATUS_LABEL_TRIAGED,
  PR_STATUS_LABELS,
} from "lib/prStatus";
import { PR_CHANGES_REQUESTED } from "lib/reviewApproval";
import { Context, Probot } from "probot";
import { isInPreReview, markInProgressIfAccepted } from "./preReviewUtils";
import { hasVerifiedHumanWritePermissions, isPyTorchPyTorch } from "./utils";

async function removeLabelIfPresent(
  context: Context<"pull_request" | "pull_request_review">,
  name: string
) {
  try {
    await context.octokit.issues.removeLabel(context.issue({ name }));
  } catch (error) {
    // A concurrent handler or a replay may have already removed it. Other
    // failures must surface so the delivery can be retried.
    if ((error as { status?: number }).status !== 404) {
      throw error;
    }
  }
}

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

  const payload = context.payload as any;

  const isOptOutLabelEvent =
    payload.action === "labeled" &&
    (payload.label?.name === PR_STATUS_LABEL_REVIEW_OPT_OUT ||
      payload.label?.name === PR_STATUS_LABEL_IN_PROGRESS) &&
    labels.includes(PR_STATUS_LABEL_REVIEW_OPT_OUT) &&
    labels.includes(PR_STATUS_LABEL_IN_PROGRESS);

  // Ignore events that cannot change status before spending GitHub API calls.
  if (
    (payload.action === "labeled" || payload.action === "unlabeled") &&
    payload.label
  ) {
    if (!PR_STATUS_LABELS.includes(payload.label.name) && !isOptOutLabelEvent) {
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

  const isChangesRequested =
    payload.action === "submitted" &&
    payload.review?.state?.toLowerCase() === PR_CHANGES_REQUESTED;

  // Label webhooks carry mid-transition snapshots and can run concurrently.
  // Review snapshots can also predate an opt-out. Use live labels for these
  // decisions and their status refresh. A handler can still read mid-move and
  // finish last; a later status update may be needed to correct its rendering.
  if (
    payload.action === "labeled" ||
    payload.action === "unlabeled" ||
    (isChangesRequested && labels.includes(PR_STATUS_LABEL_READY_FOR_REVIEW))
  ) {
    labels = await fetchLiveLabels(
      context.octokit as any,
      owner,
      repo,
      pullRequest.number
    );
  }

  // Opting out skips the readiness checks, whichever of the two labels
  // arrived second. Opted-out ready PRs stay ready after a change request.
  if (
    isOptOutLabelEvent &&
    labels.includes(PR_STATUS_LABEL_REVIEW_OPT_OUT) &&
    labels.includes(PR_STATUS_LABEL_IN_PROGRESS)
  ) {
    await context.octokit.issues.addLabels(
      context.issue({ labels: [PR_STATUS_LABEL_READY_FOR_REVIEW] })
    );
    await removeLabelIfPresent(context, PR_STATUS_LABEL_IN_PROGRESS);
    labels = await fetchLiveLabels(
      context.octokit as any,
      owner,
      repo,
      pullRequest.number
    );
  }

  // A maintainer requesting changes sends a ready PR back to in progress,
  // unless automated review is disabled. Labels move before comment refresh,
  // so a failed refresh cannot block the move. Promotion now requires a fresh
  // automated review that has considered the maintainer's feedback (see
  // lib/prReview/readyForReviewPromotion.ts).
  if (
    isChangesRequested &&
    labels.includes(PR_STATUS_LABEL_READY_FOR_REVIEW) &&
    !labels.includes(PR_STATUS_LABEL_REVIEW_OPT_OUT) &&
    (await hasVerifiedHumanWritePermissions(context, payload.review.user.login))
  ) {
    context.log(
      `Moving ${owner}/${repo}#${pullRequest.number} back to "${PR_STATUS_LABEL_IN_PROGRESS}", changes requested by ${payload.review.user.login}`
    );
    // Add before removing so the PR always carries a status label.
    await context.octokit.issues.addLabels(
      context.issue({ labels: [PR_STATUS_LABEL_IN_PROGRESS] })
    );
    await removeLabelIfPresent(context, PR_STATUS_LABEL_READY_FOR_REVIEW);
    labels = await fetchLiveLabels(
      context.octokit as any,
      owner,
      repo,
      pullRequest.number
    );
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
