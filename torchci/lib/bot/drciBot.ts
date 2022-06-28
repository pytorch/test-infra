import { Context, Probot } from "probot";

export const drciCommentStart = "<!-- drci-comment-start -->\n";
export const officeHoursUrl = "https://github.com/pytorch/pytorch/wiki/Dev-Infra-Office-Hours";
export const docsBuildsUrl = "https://docs-preview.pytorch.org/"
export const pythonDocsUrl = "/index.html"
export const cppDocsUrl = "/cppdocs/index.html"
const drciCommentEnd = "\n<!-- drci-comment-end -->";
const possibleUsers = ["swang392"]
const hudUrl = "https://hud.pytorch.org/pr/";

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
  let body = "# Helpful Links\n";
  body += `* See artifacts and rendered test results [here](${hudUrl}${prNum})\n`;
  body += `* Preview [Python docs built from this PR](${docsBuildsUrl}${prNum}${pythonDocsUrl})\n`;
  body += `* Preview [C++ docs built from this PR](${docsBuildsUrl}${prNum}${cppDocsUrl})\n`;
  body += `* Need help or want to give feedback on the CI? Visit our [office hours](${officeHoursUrl})\n`;
  body += `Note: Links to docs will display an error until the docs builds have been completed.`;
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
      context.log(
        `Updated comment with "${drciComment}" for pull request ${context.payload.pull_request.html_url}`
      );
    }
  });
}
