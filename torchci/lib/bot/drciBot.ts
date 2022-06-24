import { Context, Probot } from "probot";

const drciCommentStart = "<!-- drci-comment-start -->";
const drciCommentEnd = "<!-- drci-comment-end -->";
const possibleUsers = ["swang392"]
const officeHoursLink = "https://github.com/pytorch/pytorch/wiki/Dev-Infra-Office-Hours";

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

export function formDrciComment(prNum: number): string {
  const hudUrl = "hud.pytorch.org/pr/" + prNum;
  let body = "<h1>Helpful Links</h1>\n";
  body += "<body>See artifacts and rendered test results [here](" + hudUrl + ")\n";
  body += "Need help or want to give feedback on the CI? Visit our [office hours](" + officeHoursLink + ")";
  body += "</body>";
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

    const existingDrciData = await getDrciComment(
      context,
      prNum,
      owner,
      repo
    );
    const existingDrciID = existingDrciData.id
    const existingDrciComment = existingDrciData.body

    const drciComment = formDrciComment(prNum);

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
    }
  });
}
