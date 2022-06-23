import { Context, Probot } from "probot";

const drciCommentStart = "<!-- drci-comment-start -->";
const drciCommentEnd = "<!-- drci-comment-end -->";
const possibleUsers = ["swang392"]

async function getDrciComment(
  context: Context,
  prNum: number,
  owner: string,
  repo: string
): Promise<[number, string]> {
  const commentsRes = await context.octokit.issues.listComments({
    owner,
    repo,
    issue_number: prNum,
  });
  for (const comment of commentsRes.data) {
    if (comment.body!.includes(drciCommentStart)) {
      return [comment.id, comment.body!];
    }
  }
  return [0, ""];
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

    if (possibleUsers.indexOf(pr_owner) == -1) {
      context.log("did not make a comment")
      return;
    }

    const existingValidationCommentData = await getDrciComment(
      context,
      prNum,
      owner,
      repo
    );
    const existingValidationCommentID = existingValidationCommentData[0];
    const existingValidationComment = existingValidationCommentData[1];

    const drciComment = formDrciComment();

    if (existingValidationComment === drciComment) {
      return;
    }

    if (existingValidationCommentID === 0) {
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
        comment_id: existingValidationCommentID,
      });
    }
  });
}
