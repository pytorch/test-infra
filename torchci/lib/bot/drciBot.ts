import { Context, Probot } from "probot";
import * as drciUtils from "lib/drciUtils";

async function getDrciComment(
  context: Context,
  prNum: number,
  owner: string,
  repo: string
): Promise<{ id: number; body: string }> {
  const commentsRes = await context.octokit.issues.listComments({
    owner,
    repo,
    issue_number: prNum,
  });
  for (const comment of commentsRes.data) {
    if (comment.body!.includes(drciUtils.DRCI_COMMENT_START)) {
      return { id: comment.id, body: comment.body! };
    }
  }
  return { id: 0, body: "" };
}

export default function drciBot(app: Probot): void {
  app.on(
    ["pull_request.opened", "pull_request.synchronize"],
    async (context) => {
      const prNum = context.payload.pull_request.number;
      const pr_owner = context.payload.pull_request.user.login;
      const repo = context.payload.repository.name;
      const owner = context.payload.repository.owner.login;

      context.log(pr_owner);

      if (!drciUtils.POSSIBLE_USERS.includes(pr_owner)) {
        context.log("did not make a comment");
        return;
      }

      const existingDrciData = await getDrciComment(
        context,
        prNum,
        owner,
        repo
      );
      const existingDrciID = existingDrciData.id;
      const existingDrciComment = existingDrciData.body;
      
      const drciComment = drciUtils.formDrciComment(prNum, "");

      if (existingDrciComment === drciComment) {
        return;
      }

      if (existingDrciID === 0) {
        await context.octokit.issues.createComment({
          body: drciComment,
          owner,
          repo,
          issue_number: prNum,
        });
        context.log(
          `Commenting with "${drciComment}" for pull request ${context.payload.pull_request.html_url}`
        );
      } else {
        await context.octokit.issues.updateComment({
          body: drciComment,
          owner,
          repo,
          comment_id: existingDrciID,
        });
        context.log(
          `Updated comment with "${drciComment}" for pull request ${context.payload.pull_request.html_url}`
        );
      }
    }
  );
}
