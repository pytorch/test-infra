// Keeps the PR Status section of the Dr.CI comment current between sweeps.
//
// The section is rendered by the Dr.CI sweep like every other part of the
// comment, but the sweep is woken by CI activity and runs at most every 15
// minutes -- so without this a contributor whose PR was just triaged reads a
// stale stage, or none at all, for a quarter of an hour after the event that
// changed it. The label and review webhooks are exactly the events that move a
// PR between stages, so they poke the section directly.
//
// It splices the section into the existing comment in place rather than
// rebuilding it: a rebuild here would have no CI results to put back and would
// blank out everything the sweep rendered.

import { upsertPrStatusSection } from "lib/drciUtils";
import {
  hasPrStatusLabel,
  PR_STATUS_LABEL_TRIAGED,
  PR_STATUS_LABELS,
} from "lib/prStatus";
import { Context, Probot } from "probot";
// isDrCIEnabled already calls isPyTorchbotSupportedOrg, so it is the only gate
// needed here.
import { isDrCIEnabled } from "./utils";

async function handle(
  context: Context<"pull_request" | "pull_request_review">
) {
  const owner = context.payload.repository.owner.login;
  const repo = context.payload.repository.name;
  if (!isDrCIEnabled(owner, repo)) {
    context.log(`${__filename} isn't enabled on ${owner}/${repo}`);
    return;
  }

  const pullRequest = context.payload.pull_request;
  if (pullRequest.state !== "open") {
    return;
  }

  const labels = pullRequest.labels.map((label) => label.name);

  // pytorch/pytorch churns ciflow/*, module:* and friends constantly, and every
  // one of these events would otherwise cost at least a listComments on the
  // shared installation token. Only the events that can actually change what
  // this section renders are worth a request.
  const payload = context.payload as any;
  if (
    (payload.action === "labeled" || payload.action === "unlabeled") &&
    payload.label
  ) {
    // A label object is present, so this is a specific label going on or off
    // one PR and can be judged directly.
    if (!PR_STATUS_LABELS.includes(payload.label.name)) {
      return;
    }
  } else if (
    payload.action === "review_requested" ||
    payload.action === "review_request_removed"
  ) {
    // The reviewer list is only named by the pre-review message.
    if (!labels.includes(PR_STATUS_LABEL_TRIAGED)) {
      return;
    }
  } else if (!hasPrStatusLabel(labels)) {
    // A review on a PR outside the workflow -- or an `unlabeled` with no label
    // object, which GitHub sends when a label is deleted repo-wide rather than
    // removed from one PR. Either way the section could only render empty, and
    // a stale one cannot be present on a PR whose labels say it is out of the
    // workflow. Returning here is what keeps every review comment on every open
    // PR in every Dr.CI repo from costing a listComments.
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
      // Move between stages.
      "pull_request.labeled",
      "pull_request.unlabeled",
      // Change the assigned-reviewer list the pre-review message names. The spec
      // requires it stay up to date with removals and additions, and a sweep
      // that only CI activity wakes cannot promise that.
      "pull_request.review_requested",
      "pull_request.review_request_removed",
      // Approval outranks the labels, so it changes the stage on its own.
      "pull_request_review.submitted",
      "pull_request_review.dismissed",
    ],
    handle
  );
}
