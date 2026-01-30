import { Probot } from "probot";
import {
  addLabelErrComment,
  deleteLabelErrComment,
  hasRequiredLabels,
} from "./checkLabelsUtils";
import { isPyTorchPyTorch } from "./utils";

export default function checkLabelsBot(app: Probot): void {
  // NOTE: We intentionally do NOT handle pull_request.opened here.
  // The autoLabelBot handles that event and will check labels after
  // auto-labeling is complete, to avoid a race condition where we
  // post an error comment before auto-labeling has a chance to add
  // the required labels.

  // Check labels when a label is added - delete error comment if now valid
  app.on("pull_request.labeled", async (context) => {
    const owner = context.payload.repository.owner.login;
    const repo = context.payload.repository.name;

    // Only run on pytorch/pytorch
    if (!isPyTorchPyTorch(owner, repo)) {
      return;
    }

    const prNum = context.payload.pull_request.number;
    const labels = context.payload.pull_request.labels.map(
      (l: { name: string }) => l.name
    );

    context.log(`Checking labels for labeled PR ${prNum}`);

    if (hasRequiredLabels(labels)) {
      await deleteLabelErrComment(
        context.octokit as any,
        owner,
        repo,
        prNum,
        context
      );
    }
  });

  // Check labels when a label is removed - add error comment if no longer valid
  app.on("pull_request.unlabeled", async (context) => {
    const owner = context.payload.repository.owner.login;
    const repo = context.payload.repository.name;

    // Only run on pytorch/pytorch
    if (!isPyTorchPyTorch(owner, repo)) {
      return;
    }

    const prNum = context.payload.pull_request.number;
    const labels = context.payload.pull_request.labels.map(
      (l: { name: string }) => l.name
    );

    context.log(`Checking labels for unlabeled PR ${prNum}`);

    if (!hasRequiredLabels(labels)) {
      await addLabelErrComment(
        context.octokit as any,
        owner,
        repo,
        prNum,
        context
      );
    }
  });
}
