/*
A github bot that automatically approves workflow runs for first time contributors
if the PR only changes safe, non-workflow related files.
*/

import { Probot } from "probot";
import {
  approveWorkflowRun,
  getFilesChangedByPr,
  isFirstTimeContributor,
  isPyTorchPyTorch,
} from "./utils";
import { workflowRelatedPatterns } from "./Constants";

function myBot(app: Probot): void {
  function isWorkflowRelated(filesChanged: string[]): boolean {
    return (
      filesChanged.length > 0 &&
      filesChanged.some((f) => workflowRelatedPatterns.some((p) => f.match(p)))
    );
  }

  app.on(
    ["pull_request.opened", "pull_request.edited", "pull_request.synchronize"],
    async (context) => {
      const owner = context.payload.repository.owner.login;
      const repo = context.payload.repository.name;
      const title = context.payload.pull_request.title;
      const filesChanged = await getFilesChangedByPr(
        context.octokit,
        owner,
        repo,
        context.payload.pull_request.number
      );
      context.log({ title, filesChanged });

      if (!isPyTorchPyTorch(owner, repo)) {
        // Only run on PyTorch/PyTorch initially
        return;
      }

      if (
        !await isFirstTimeContributor(
          context,
          context.payload.pull_request.user.login
        )
      ) {
        // Only needed for first time contributors
        return;
      }

      // Don't autostart runs if any of the workflow execution files have been changed
      if (isWorkflowRelated(filesChanged)) {
        return;
      }

      // Approve the workflow execution
      approveWorkflowRun(
        context.octokit,
        owner,
        repo,
        context.payload.pull_request.number
      );
    }
  );
}

export default myBot;
