import * as singleDisableIssue from "lib/flakyBot/singleDisableIssue";
import { Context, Probot } from "probot";
import { hasWritePermissions } from "./utils";

export const validationCommentStart = "<!-- validation-comment-start -->";
export const validationCommentEnd = "<!-- validation-comment-end -->";
export const disabledKey = "DISABLED ";
export const unstableKey = "UNSTABLE ";
export const disabledTestIssueTitle = new RegExp(
  "DISABLED\\s*test.+\\s*\\(.+\\)"
);
export const pytorchBotId = 54816060;

async function getValidationComment(
  context: Context,
  issueNumber: number,
  owner: string,
  repo: string
): Promise<[number, string]> {
  const commentsRes = await context.octokit.issues.listComments({
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 10,
  });
  for (const comment of commentsRes.data) {
    if (comment.body!.includes(validationCommentStart)) {
      return [comment.id, comment.body!];
    }
  }
  return [0, ""];
}

export function parseTitle(title: string, prefix: string): string {
  return title.slice(prefix.length).trim();
}

export function formJobValidationComment(
  username: string,
  authorized: boolean,
  jobName: string,
  prefix: string
): string {
  const trimPrefix = prefix.trim();
  let body = `<body>Hello there! From the ${trimPrefix} prefix in this issue title, `;
  body += `it looks like you are attempting to ${trimPrefix.toLowerCase()} a job in PyTorch CI. `;
  body += "The information I have parsed is below:\n\n";
  body += `* Job name: \`${jobName}\`\n`;
  body += `* Credential: \`${username}\`\n\n`;

  if (!authorized) {
    body += `<b>ERROR!</b> You (${username}) don't have permission to ${trimPrefix.toLowerCase()} ${jobName}.\n\n`;
  } else {
    body += `Within ~15 minutes, \`${jobName}\` and all of its dependants will be ${trimPrefix.toLowerCase()} in PyTorch CI. `;
    body +=
      "Please verify that the job name looks correct. With great power comes great responsibility.\n\n";
  }
  body += "</body>";

  return validationCommentStart + body + validationCommentEnd;
}

export function isDisabledTest(title: string): boolean {
  return disabledTestIssueTitle.test(title);
}

export default function verifyDisableTestIssueBot(app: Probot): void {
  app.on(["issues.opened", "issues.edited"], async (context) => {
    const state = context.payload["issue"]["state"];
    const title = context.payload["issue"]["title"];
    const owner = context.payload["repository"]["owner"]["login"];
    const repo = context.payload["repository"]["name"];

    if (
      state === "closed" ||
      (!title.startsWith(disabledKey) && !title.startsWith(unstableKey))
    ) {
      return;
    }

    const prefix = title.startsWith(disabledKey) ? disabledKey : unstableKey;
    const body = context.payload["issue"]["body"];
    const number = context.payload["issue"]["number"];
    const existingValidationCommentData = await getValidationComment(
      context,
      number,
      owner,
      repo
    );
    const existingValidationCommentID = existingValidationCommentData[0];
    const existingValidationComment = existingValidationCommentData[1];

    const target = parseTitle(title, prefix);
    const { platformsToSkip, invalidPlatforms } = singleDisableIssue.parseBody(
      body!
    );
    const username = context.payload["issue"]["user"]["login"];
    const authorized =
      context.payload["issue"]["user"]["id"] === pytorchBotId ||
      (await hasWritePermissions(context, username));
    const labels =
      context.payload["issue"]["labels"]?.map((l) => l["name"]) ?? [];

    const validationComment = isDisabledTest(title)
      ? singleDisableIssue.formValidationComment(
          username,
          authorized,
          target,
          platformsToSkip,
          invalidPlatforms,
          number
        )
      : formJobValidationComment(username, authorized, target, prefix);

    if (existingValidationComment === validationComment) {
      return;
    }

    if (existingValidationCommentID === 0) {
      await context.octokit.issues.createComment({
        body: validationComment,
        owner,
        repo,
        issue_number: number,
      });
    } else {
      await context.octokit.issues.updateComment({
        body: validationComment,
        owner,
        repo,
        comment_id: existingValidationCommentID,
      });
    }

    // Auto-close unauthorized issues
    if (!authorized) {
      await context.octokit.issues.update({
        owner,
        repo,
        issue_number: number,
        state: "closed",
      });
    } else {
      // check labels, add labels as needed
      let [expectedPlatformLabels, invalidPlatformLabels] =
        singleDisableIssue.getExpectedPlatformModuleLabels(
          platformsToSkip,
          labels
        );
      let labelsSet = new Set(labels);
      if (!expectedPlatformLabels.every((label) => labelsSet.has(label))) {
        await context.octokit.issues.addLabels({
          owner,
          repo,
          issue_number: number,
          labels: expectedPlatformLabels,
        });
      }
      for (const invalidLabel of invalidPlatformLabels) {
        await context.octokit.issues.removeLabel({
          owner,
          repo,
          issue_number: number,
          name: invalidLabel,
        });
      }
    }
  });
}
