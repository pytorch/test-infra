import { Context, Probot } from "probot";

const drciCommentStart = "<!-- drci-comment-start -->";
const drciCommentEnd = "<!-- drci-comment-end -->";
const possibleUsers = ["swang392"]

async function getDrciComment(
  context: Context,
  prNum: number,
  owner: string,
  repo: string
): Promise<{id: number, body: string}> {
  const commentsRes = await context.octokit.issues.listComments({
    owner,
    repo,
    issue_number: prNum,
  });
  for (const comment of commentsRes.data) {
    if (comment.body!.includes(drciCommentStart)) {
      return {id: comment.id, body: comment.body!};
    }
  }
  return {id: 0, body: ""};
}

export function formDrciComment(): string {
  let body = "hello there!"
  return drciCommentStart + body + drciCommentEnd;
}

export default function drciBot(app: Probot): void {
  app.on(["pull_request.opened", "pull_request.synchronize"], async (context) => {
    const prNum = context.payload.pull_request.number;
    const pr_owner = context.payload.pull_request.user.login;
    const repo = context.payload.repository.name;
    const owner = context.payload.repository.owner.login;
    
    context.log(pr_owner);

    if (!possibleUsers.includes(pr_owner)) {
      context.log("did not make a comment")
      return;
    }

    const existingDrCIData = await getDrciComment(
      context,
      prNum,
      owner,
      repo
    );
    const existingDrCIID = existingDrCIData.id
    const existingDrCIComment = existingDrCIData.body

    const drciComment = formDrciComment();

    if (existingDrCIComment === drciComment) {
      return;
    }

    if (existingDrCIID === 0) {
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
        comment_id: existingDrCIID,
      });
    }
  });
}
