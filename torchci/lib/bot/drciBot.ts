import { Context, Probot } from "probot";
import { DRCI_COMMENT_START, OWNER, REPO, formDrciComment } from "lib/drciUtils";
import { POSSIBLE_USERS } from "lib/bot/rolloutUtils";

async function getDrciComment(
  context: Context,
  prNum: number,
): Promise<{ id: number; body: string }> {
  const commentsRes = await context.octokit.issues.listComments({
    owner: OWNER,
    repo: REPO,
    issue_number: prNum,
  });
  for (const comment of commentsRes.data) {
    if (comment.body!.includes(DRCI_COMMENT_START)) {
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

      context.log(pr_owner);

      if (!POSSIBLE_USERS.includes(pr_owner)) {
        context.log("did not make a comment");
        return;
      }

      const existingDrciData = await getDrciComment(
        context,
        prNum,
      );
      const existingDrciID = existingDrciData.id;
      const existingDrciComment = existingDrciData.body;
      const drciComment = formDrciComment(prNum);

      if (existingDrciComment === drciComment) {
        return;
      }

      if (existingDrciID === 0) {
        await context.octokit.issues.createComment({
          body: drciComment,
          owner: OWNER,
          repo: REPO,
          issue_number: prNum,
        });
        context.log(
          `Commenting with "${drciComment}" for pull request ${context.payload.pull_request.html_url}`
        );
      } else {
        await context.octokit.issues.updateComment({
          body: drciComment,
          owner: OWNER,
          repo: REPO,
          comment_id: existingDrciID,
        });
        context.log(
          `Updated comment with "${drciComment}" for pull request ${context.payload.pull_request.html_url}`
        );
      }
    }
  );
}
