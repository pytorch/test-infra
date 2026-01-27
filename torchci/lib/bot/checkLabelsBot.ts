import { Probot } from "probot";
import {
  addLabelErrComment,
  deleteLabelErrComment,
  hasRequiredLabels,
} from "./checkLabelsUtils";
import { isPyTorchPyTorch } from "./utils";

export default function checkLabelsBot(app: Probot): void {
  // Check labels when a PR is opened
  app.on("pull_request.opened", async (context) => {
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

    context.log(`Checking labels for opened PR ${prNum}`);

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
