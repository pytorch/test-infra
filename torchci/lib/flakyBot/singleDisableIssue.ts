import dayjs from "dayjs";
import {
  validationCommentEnd,
  validationCommentStart,
} from "lib/bot/verifyDisableTestIssueBot";
import { DisabledNonFlakyTestData, FlakyTestData, IssueData } from "lib/types";
import _ from "lodash";
import { Octokit } from "octokit";
import { NUM_HOURS } from "pages/api/flaky-tests/disable";
import {
  getLatestTrunkJobURL,
  getPlatformLabels,
  getPlatformsAffected,
  getTestOwnerLabels,
  getWorkflowJobNames,
  NUM_HOURS_NOT_UPDATED_BEFORE_CLOSING,
  supportedPlatforms,
} from "./utils";

export const PYTORCH: string = "pytorch";
const NUM_HOURS_ACROSS_JOBS = 72;

// MARK: create issue
export function getIssueTitle(testName: string, testSuite: string) {
  let suite = testSuite;
  // If the test class is not a subclass, it belongs to __main__
  if (testSuite.indexOf(".") < 0) {
    suite = "__main__." + suite;
  }
  return `DISABLED ${testName} (${suite})`;
}

export function getIssueBodyForFlakyTest(test: FlakyTestData): string {
  let examplesURL = `https://hud.pytorch.org/flakytest?name=${test.name}&suite=${test.suite}&limit=100`;
  let numRedGreen = `Over the past ${NUM_HOURS} hours, it has been determined flaky in ${test.workflowIds.length} workflow(s) with ${test.numRed} failures and ${test.numGreen} successes.`;
  let debuggingSteps = `**Debugging instructions (after clicking on the recent samples link):**
  DO NOT ASSUME THINGS ARE OKAY IF THE CI IS GREEN. We now shield flaky tests from developers so CI will thus be green but it will be harder to parse the logs.
  To find relevant log snippets:
  1. Click on the workflow logs linked above
  2. Click on the Test step of the job so that it is expanded. Otherwise, the grepping will not work.
  3. Grep for \`${test.name}\`
  4. There should be several instances run (as flaky tests are rerun in CI) from which you can study the logs.
  `;
  let fileInfo = `Test file path: \`${test.file}\``;
  if (test.file !== `${test.invoking_file}.py`) {
    fileInfo += ` or \`${test.invoking_file}\``;
  }

  let sampleTraceback = "";
  if (test.sampleTraceback) {
    function toCodeBlock(text: string): string {
      return `\`\`\`\n${text}\n\`\`\``;
    }
    let inDetails = "";
    // Rather arbitrary length to avoid printing a massive traceback
    if (test.sampleTraceback.length > 30000) {
      const truncatedTrackback = test.sampleTraceback.slice(-30000);
      inDetails = `Truncated for length\n${toCodeBlock(truncatedTrackback)}`;
    } else {
      inDetails = toCodeBlock(test.sampleTraceback);
    }
    sampleTraceback = `\n\n<details><summary>Sample error message</summary>\n\n${inDetails}\n\n</details>\n\n`;
  }

  if (test.numRed === undefined) {
    // numRed === undefined indicates that is from the 'flaky_tests/across_jobs' query
    numRedGreen = `Over the past ${NUM_HOURS_ACROSS_JOBS} hours, it has flakily failed in ${test.workflowIds.length} workflow(s).`;
    examplesURL = `https://hud.pytorch.org/failure/${test.name}`;
    debuggingSteps = `**Debugging instructions (after clicking on the recent samples link):**
  To find relevant log snippets:
  1. Click on the workflow logs linked above
  2. Grep for \`${test.name}\`
  `;
  }
  return `Platforms: ${getPlatformsAffected(getWorkflowJobNames(test)).join(
    ", "
  )}

  This test was disabled because it is failing in CI. See [recent examples](${examplesURL}) and the most recent trunk [workflow logs](${getLatestTrunkJobURL(
    test
  )}).

  ${numRedGreen}

  ${debuggingSteps}
  ${sampleTraceback}
  ${fileInfo}

  For all disabled tests (by GitHub issue), see https://hud.pytorch.org/disabled.`;
}

export async function createIssueFromFlakyTest(
  test: FlakyTestData,
  octokit: Octokit
): Promise<void> {
  const title = getIssueTitle(test.name, test.suite);
  let body = getIssueBodyForFlakyTest(test);
  const { labels, additionalErrMessage } = await getTestOwnerLabels(test);
  if (additionalErrMessage) {
    body += `\n\n${additionalErrMessage}`;
  }
  await octokit.rest.issues.create({
    owner: PYTORCH,
    repo: PYTORCH,
    title,
    body,
    labels: ["skipped", "module: flaky-tests"].concat(labels),
  });
}

// MARK: update issue

export async function updateExistingIssueForFlakyTest(
  octokit: Octokit,
  matchingIssue: IssueData,
  test: FlakyTestData
) {
  const platformsAffected = getPlatformsAffected(getWorkflowJobNames(test));
  const { platformsToSkip: platformsInIssue, bodyWithoutPlatforms } = parseBody(
    matchingIssue.body
  );
  const platformsNotInIssue = platformsAffected.filter(
    (p) => platformsInIssue.length !== 0 && !platformsInIssue.includes(p)
  );
  const latestTrunkJobURL = getLatestTrunkJobURL(test);

  // Pre define strings in order to make the yarn format look slightly nicer
  const platformsInIssueStr =
    platformsInIssue.length == 0 ? "all" : platformsInIssue.join(", ");
  const platformsAffectedStr = platformsAffected.join(", ");
  const platformsNotInIssueStr = platformsNotInIssue.join(", ");

  let comment = `Another case of trunk flakiness has been found [here](${latestTrunkJobURL}). `;
  if (matchingIssue.state !== "open") {
    comment += `Reopening issue. `;
  }
  let newBody = undefined;

  if (platformsNotInIssue.length === 0) {
    comment += `The list of platforms [${platformsInIssueStr}] appears to contain all the recently affected platforms [${platformsAffectedStr}]. `;
    if (matchingIssue.state === "open") {
      comment += `Either the change didn't propogate fast enough or disable bot might be broken. `;
    }
  } else {
    const allPlatformsStr = platformsInIssue
      .concat(platformsNotInIssue)
      .join(", ");
    comment +=
      `The list of platforms [${platformsInIssueStr}] does not appear to contain all the recently affected platforms [${platformsAffectedStr}]. ` +
      `Adding [${platformsNotInIssueStr}]. `;
    newBody = `Platforms: ${allPlatformsStr}\n\n${bodyWithoutPlatforms}`;
  }
  await octokit.rest.issues.createComment({
    owner: PYTORCH,
    repo: PYTORCH,
    issue_number: matchingIssue.number,
    body: comment,
  });
  if (newBody !== undefined || matchingIssue.state !== "open") {
    await octokit.rest.issues.update({
      owner: PYTORCH,
      repo: PYTORCH,
      issue_number: matchingIssue.number,
      body: newBody,
      state: "open",
    });
  }
}
// MARK: close issue
export async function handleNonFlakyTest(
  test: DisabledNonFlakyTestData,
  issues: IssueData[],
  octokit: Octokit
) {
  const issueTitle = getIssueTitle(test.name, test.classname);
  const matchingIssues = issues.filter((issue) => issue.title === issueTitle);

  if (matchingIssues.length === 0) {
    return;
  }

  const matchingIssue = matchingIssues[0];

  if (matchingIssue.state === "open") {
    const updatedAt = dayjs(matchingIssue.updated_at);
    const daysSinceLastUpdate: number =
      NUM_HOURS_NOT_UPDATED_BEFORE_CLOSING / 24;

    // Only close the issue if the issue is not flaky and hasn't been updated in
    // NUM_HOURS_NOT_UPDATED_BEFORE_CLOSING hours, defaults to 2 weeks
    if (
      updatedAt.isAfter(
        dayjs().subtract(NUM_HOURS_NOT_UPDATED_BEFORE_CLOSING, "hour")
      )
    ) {
      console.log(`${matchingIssue.number} is not flaky but is too recent.`);
      return;
    }
    console.log(`${matchingIssue.number} is not longer flaky`);

    const body =
      `Resolving the issue because the test is not flaky anymore after ${test.num_green} reruns without ` +
      `any failures and the issue hasn't been updated in ${daysSinceLastUpdate} days. Please reopen the ` +
      `issue to re-disable the test if you think this is a false positive`;
    await octokit.rest.issues.createComment({
      owner: PYTORCH,
      repo: PYTORCH,
      issue_number: matchingIssue.number,
      body,
    });

    // Close the issue
    await octokit.rest.issues.update({
      owner: PYTORCH,
      repo: PYTORCH,
      issue_number: matchingIssue.number,
      state: "closed",
    });
  }
}
// MARK: parse issue

export function parseBody(body: string) {
  if (body === "") {
    return {
      platformsToSkip: [],
      invalidPlatforms: [],
      bodyWithoutPlatforms: "",
    };
  }
  const lines = body.match(/([^\r\n]+)|(\r|\n)+/g);
  const platformsToSkip = new Set<string>();
  const invalidPlatforms = new Set<string>();
  const bodyWithoutPlatforms = [];
  const key = "platforms:";
  for (let line of lines!) {
    let lowerCaseLine = line.toLowerCase().trim();
    if (lowerCaseLine.startsWith(key)) {
      for (const platform of lowerCaseLine
        .slice(key.length)
        .split(/^\s+|\s*,\s*|\s+$/)) {
        if (supportedPlatforms.has(platform)) {
          platformsToSkip.add(platform);
        } else if (platform !== "") {
          invalidPlatforms.add(platform);
        }
      }
    } else {
      bodyWithoutPlatforms.push(line);
    }
  }
  return {
    platformsToSkip: Array.from(platformsToSkip).sort((a, b) =>
      a.localeCompare(b)
    ),
    invalidPlatforms: Array.from(invalidPlatforms).sort((a, b) =>
      a.localeCompare(b)
    ),
    bodyWithoutPlatforms: bodyWithoutPlatforms.join(""),
  };
}

// MARK: validation

function testNameIsExpected(testName: string): boolean {
  const split = testName.split(/\s+/);
  if (split.length !== 2) {
    return false;
  }

  const testSuite = split[1].split(".");
  if (testSuite.length < 2) {
    return false;
  }
  return true;
}

export function formValidationComment(
  username: string,
  authorized: boolean,
  testName: string,
  platformsToSkip: string[],
  invalidPlatforms: string[],
  issueNumber: number
): string {
  const platformMsg =
    platformsToSkip.length === 0
      ? "none parsed, defaulting to ALL platforms"
      : platformsToSkip.join(", ");

  let body =
    "<body>Hello there! From the DISABLED prefix in this issue title, ";
  body += "it looks like you are attempting to disable a test in PyTorch CI. ";
  body += "The information I have parsed is below:\n\n";
  body += `* Test name: \`${testName}\`\n`;
  body += `* Platforms for which to skip the test: ${platformMsg}\n`;
  body += `* Disabled by \`${username}\`\n\n`;

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

  if (!authorized) {
    body += `<b>ERROR!</b> You (${username}) don't have permission to disable ${testName} on ${platformMsg}.\n\n`;
    body += "</body>";
    return validationCommentStart + body + validationCommentEnd;
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
  body += `${Array.from(supportedPlatforms.keys())
    .sort((a, b) => a.localeCompare(b))
    .join(", ")}.\n\n`;

  body += `
### How to re-enable a test
To re-enable the test globally, close the issue. To re-enable a test for only a subset of platforms, remove the platforms from the list in the issue body. This may take some time to propagate. To re-enable a test only for a PR, put \`Fixes #${issueNumber}\` in the PR body and rerun the test jobs. Note that if a test is flaky, it maybe be difficult to tell if the test is still flaky on the PR.
`;

  body += "</body>";
  return validationCommentStart + body + validationCommentEnd;
}

// Returns the platform module labels that are expected, and invalid labels that we do not expect to be there
export function getExpectedPlatformModuleLabels(
  platforms: string[],
  labels: string[]
): [string[], string[]] {
  let supportedPlatformLabels = Array.from(supportedPlatforms.values())
    .flat()
    // Quick hack to make sure oncall: pt2 doesn't get deleted.
    // TODO: figure out a better way to differentiate between labels that should
    // stay and labels that shouldn't
    .filter((label) => label.startsWith("module: "));
  let existingPlatformLabels = labels.filter((label) =>
    supportedPlatformLabels.includes(label)
  );
  let expectedPlatformLabels = getPlatformLabels(platforms);
  // everything in labels that's not in expectedLabels is invalid
  let invalidPlatformLabels = _.difference(
    existingPlatformLabels,
    expectedPlatformLabels
  );
  return [expectedPlatformLabels, invalidPlatformLabels];
}
