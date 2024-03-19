import { hasWritePermissions, isPyTorchPyTorch } from "./utils";
import { Probot } from "probot";

const CODEV_INDICATOR = "Differential Revision: D";
const WIKI_LINK =
  "https://www.internalfb.com/intern/wiki/PyTorch/PyTorchDev/Workflow/develop/#setup-your-github-accoun";

// If a pytorch/pytorch codev PR is created but the author doesn't have write
// permissions, the bot will comment on the PR to inform the author to get write
// access.
export default function codevNoWritePerm(app: Probot): void {
  app.on("pull_request.opened", async (context) => {
    const body = context.payload.pull_request.body;
    const author = context.payload.pull_request.user.login;
    const prNumber = context.payload.pull_request.number;
    const owner = context.payload.repository.owner.login;
    const repo = context.payload.repository.name;
    if (
      isPyTorchPyTorch(owner, repo) &&
      body?.includes(CODEV_INDICATOR) &&
      !(await hasWritePermissions(context, author))
    ) {
      const body =
        "Hi there, this appears to be a diff that was exported from phabricator, " +
        `but the PR author does not have sufficient permissions to run CI. ` +
        `@${author}, please do step 2 of [internal wiki](${WIKI_LINK}) to get write access so ` +
        `you do not need to get CI approvals in the future. ` +
        "If you think this is a mistake, please contact the Pytorch Dev Infra team.";
      await context.octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body,
      });
    }
  });
}
