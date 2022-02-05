import { Context, Probot } from "probot";

const validationCommentStart = "<!-- validation-comment-start -->";
const validationCommentEnd = "<!-- validation-comment-end -->";
const disabledKey = "DISABLED ";
export const supportedPlatforms = new Set([
  "asan",
  "linux",
  "mac",
  "macos",
  "rocm",
  "win",
  "windows",
]);

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

export function parseBody(body: string): [Set<string>, Set<string>] {
  const lines = body.split(/[\r\n]+/);
  const platformsToSkip = new Set<string>();
  const invalidPlatforms = new Set<string>();
  const key = "platforms:";
  for (let line of lines) {
    line = line.toLowerCase();
    if (line.startsWith(key)) {
      for (const platform of line
        .slice(key.length)
        .split(/^\s+|\s*,\s*|\s+$/)) {
        if (supportedPlatforms.has(platform)) {
          platformsToSkip.add(platform);
        } else if (platform !== "") {
          invalidPlatforms.add(platform);
        }
      }
    }
  }
  return [platformsToSkip, invalidPlatforms];
}

export function parseTitle(title: string): string {
  return title.slice(disabledKey.length).trim();
}

function testNameIsExpected(testName: string): boolean {
  const split = testName.split(" ");
  if (split.length !== 2) {
    return false;
  }

  const testSuite = split[1].split(".");
  if (testSuite.length !== 2) {
    return false;
  }
  return true;
}

export function formValidationComment(
  testName: string,
  platforms: [Set<string>, Set<string>]
): string {
  const platformsToSkip = Array.from(platforms[0]).sort((a, b) =>
    a.localeCompare(b)
  );
  const platformMsg =
    platformsToSkip.length === 0
      ? "none parsed, defaulting to ALL platforms"
      : platformsToSkip.join(", ");
  const invalidPlatforms = Array.from(platforms[1]).sort((a, b) =>
    a.localeCompare(b)
  );

  let body =
    "<body>Hello there! From the DISABLED prefix in this issue title, ";
  body += "it looks like you are attempting to disable a test in PyTorch CI. ";
  body += "The information I have parsed is below:\n\n";
  body += `* Test name: \`${testName}\`\n`;
  body += `* Platforms for which to skip the test: ${platformMsg}\n\n`;

  if (invalidPlatforms.length > 0) {
    body +=
      "<b>WARNING!</b> In the parsing process, I received these invalid inputs as platforms for ";
    body += `which the test will be disabled: ${invalidPlatforms.join(
      ", "
    )}. These could `;
    body +=
      "be typos or platforms we do not yet support test disabling. Please ";
    body +=
      "verify the platform list above and modify your issue body if needed.\n\n";
  }

  if (!testNameIsExpected(testName)) {
    body +=
      "<b>ERROR!</b> As you can see above, I could not properly parse the test ";
    body +=
      "information and determine which test to disable. Please modify the ";
    body +=
      "title to be of the format: DISABLED test_case_name (test.ClassName), ";
    body += "for example, `test_cuda_assert_async (__main__.TestCuda)`.\n\n";
  } else {
    body += `Within ~15 minutes, \`${testName}\` will be disabled in PyTorch CI for `;
    body +=
      platformsToSkip.length === 0
        ? "all platforms"
        : `these platforms: ${platformsToSkip.join(", ")}`;
    body +=
      ". Please verify that your test name looks correct, e.g., `test_cuda_assert_async (__main__.TestCuda)`.\n\n";
  }

  body +=
    "To modify the platforms list, please include a line in the issue body, like below. The default ";
  body +=
    "action will disable the test for all platforms if no platforms list is specified. \n";
  body +=
    "```\nPlatforms: case-insensitive, list, of, platforms\n```\nWe currently support the following platforms: ";
  body += `${Array.from(supportedPlatforms)
    .sort((a, b) => a.localeCompare(b))
    .join(", ")}.</body>`;

  return validationCommentStart + body + validationCommentEnd;
}

export default function verifyDisableTestIssueBot(app: Probot): void {
  app.on(["issues.opened", "issues.edited"], async (context) => {
    const state = context.payload["issue"]["state"];
    const title = context.payload["issue"]["title"];
    const owner = context.payload["repository"]["owner"]["login"];
    const repo = context.payload["repository"]["name"];

    if (state === "closed" || !title.startsWith(disabledKey)) {
      return;
    }

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

    const testName = parseTitle(title);
    const platforms = parseBody(body!);
    const validationComment = formValidationComment(testName, platforms);

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
  });
}
