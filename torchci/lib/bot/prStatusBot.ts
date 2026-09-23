// Refreshes PR Status on label and review webhooks instead of waiting for the
// CI-driven sweep. Only that section changes, preserving existing CI results.

import { upsertPrStatusSection } from "lib/drciUtils";
import {
  hasPrStatusLabel,
  PR_STATUS_LABEL_TRIAGED,
  PR_STATUS_LABELS,
} from "lib/prStatus";
import { Context, Probot } from "probot";
import { isPyTorchPyTorch } from "./utils";

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

  const labels = pullRequest.labels.map((label) => label.name);

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

  await upsertPrStatusSection(
    context.octokit as any,
    owner,
    repo,
    pullRequest.number,
    labels,
    pullRequest.user?.login
  );
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
