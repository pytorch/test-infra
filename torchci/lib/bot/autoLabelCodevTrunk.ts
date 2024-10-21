// Bot that adds ciflow/trunk label to PRs in pytorch/pytorch that are codev
// that have been approved or imported.  Can be viewed as a sub-bot of
// autoLabelBot, put into its own file for clarity and easier testing.
import { Probot } from "probot";
import { addNewLabels, canRunWorkflows } from "./autoLabelBot";
import {
  CODEV_INDICATOR,
  genCodevNoWritePermComment,
} from "./codevNoWritePermBot";
import { isPyTorchPyTorch } from "./utils";

const CIFLOW_TRUNK_LABEL = "ciflow/trunk";

function myBot(app: Probot): void {
  app.on("pull_request_review.submitted", async (context) => {
    // Apply `ciflow/trunk` to PRs in PyTorch/PyTorch that has been reviewed a
    const owner = context.payload.repository.owner.login;
    const repo = context.payload.repository.name;
    const prAuthor = context.payload.pull_request.user.login;
    const body = context.payload.pull_request.body;
    const existingLabels = context.payload.pull_request.labels.map(
      (e) => e["name"]
    );

    if (context.payload.review.state !== "approved") {
      return;
    }

    if (!isPyTorchPyTorch(owner, repo)) {
      return;
    }

    // only applies label to codev diffs.
    if (!body?.match(CODEV_INDICATOR)) {
      return;
    }

    // Is codev but doesn't have approvals means the author is a metamate but
    // doesn't have write permissions, so post link to get write access
    // I think only one of these checks is really needed
    if (!(await canRunWorkflows(context))) {
      await context.octokit.issues.createComment({
        owner,
        repo,
        issue_number: context.payload.pull_request.number,
        body: genCodevNoWritePermComment(prAuthor),
      });
      return;
    }

    await addNewLabels(existingLabels, [CIFLOW_TRUNK_LABEL], context);
  });

  app.on("pull_request.edited", async (context) => {
    // Apply `ciflow/trunk` to PRs that have just been imported.  Pretty much
    // the same as the above but happens when the PR body is edited
    const owner = context.payload.repository.owner.login;
    const repo = context.payload.repository.name;
    const prAuthor = context.payload.pull_request.user.login;
    const body = context.payload.pull_request.body;
    const existingLabels = context.payload.pull_request.labels.map(
      (e) => e["name"]
    );

    if (!isPyTorchPyTorch(owner, repo)) {
      return;
    }

    if (context.payload.changes.body?.from.match(CODEV_INDICATOR)) {
      // Already exists, no need to add again
      return;
    }

    // only applies label to codev diffs.
    if (!body?.match(CODEV_INDICATOR)) {
      return;
    }

    // Is codev but doesn't have approvals means the author is a metamate but
    // doesn't have write permissions, so post link to get write access
    // I think only one of these checks is really needed
    if (!(await canRunWorkflows(context))) {
      await context.octokit.issues.createComment({
        owner,
        repo,
        issue_number: context.payload.pull_request.number,
        body: genCodevNoWritePermComment(prAuthor),
      });
      return;
    }

    await addNewLabels(existingLabels, [CIFLOW_TRUNK_LABEL], context);
  });
}

export default myBot;
