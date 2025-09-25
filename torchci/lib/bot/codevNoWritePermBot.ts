import { Probot } from "probot";
import {
  hasWritePermissions,
  isPyTorchbotSupportedOrg,
  isPyTorchPyTorch,
} from "./utils";

export const CODEV_INDICATOR = /Differential Revision: \[?D/;
const CODEV_WIKI_LINK =
  "https://www.internalfb.com/intern/wiki/PyTorch/PyTorchDev/Workflow/develop/#setup-your-github-accoun";

export function genCodevNoWritePermComment(author: string) {
  return (
    "This appears to be a diff that was exported from phabricator, " +
    `but the PR author does not have sufficient permissions to run CI. ` +
    `@${author}, please do step 2 of [internal wiki](${CODEV_WIKI_LINK}) to get write access so ` +
    `you do not need to get CI approvals in the future. ` +
    "If you think this is a mistake, please contact the Pytorch Dev Infra team."
  );
}

// If a pytorch/pytorch codev PR is created but the author doesn't have write
// permissions, the bot will comment on the PR to inform the author to get write
// access.
export default function codevNoWritePerm(app: Probot): void {
  app.on("pull_request.opened", async (context) => {
    const owner = context.payload.repository.owner.login;
    if (!isPyTorchbotSupportedOrg(owner)) {
      context.log(`${__filename} isn't enabled on ${owner}'s repos`);
      return;
    }

    const body = context.payload.pull_request.body;
    const author = context.payload.pull_request.user.login;
    const prNumber = context.payload.pull_request.number;
    const repo = context.payload.repository.name;
    if (
      isPyTorchPyTorch(owner, repo) &&
      body?.match(CODEV_INDICATOR) &&
      !(await hasWritePermissions(context, author))
    ) {
      await context.octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body: genCodevNoWritePermComment(author),
      });
    }
  });
}
