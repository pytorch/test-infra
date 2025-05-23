import dayjs from "dayjs";
import { DisabledNonFlakyTestData, FlakyTestData, IssueData } from "lib/types";
import _ from "lodash";
import { Octokit } from "octokit";
import { Context } from "probot";
import {
  formatTestNameForTitle,
  getIssueBodyForFlakyTest,
} from "./singleDisableIssue";
import {
  genInvalidPlatformsValidationSection,
  genReenableValidationSection,
  getLatestTrunkJobURL,
  getPlatformsAffected,
  getTestOwnerLabels,
  getWorkflowJobNames,
  NUM_HOURS_NOT_UPDATED_BEFORE_CLOSING,
  supportedPlatforms,
} from "./utils";

const PYTORCH = "pytorch";
export const MASS_FLAKY_TEST_ISSUE_LABEL = "aggregate flaky test issue";

// MARK: create issue
function getTitle(test: FlakyTestData) {
  return `DISABLED MULTIPLE There are multiple flaky tests in ${test.file}`;
}

function formatPlatformsAffected(
  platformMapping: Map<string, string[]>
): string {
  let body = "```\n";
  for (const test of Array.from(platformMapping.keys()).sort()) {
    const platforms = platformMapping.get(test)?.join(", ");
    body += `${test}: ${platforms}`.trim();
    body += "\n";
  }
  body += "```\n";
  return body;
}

function formatTestsForBody(platformMapping: Map<string, string[]>): string {
  let body = "disable the following tests:\n";
  body += formatPlatformsAffected(platformMapping);
  return body;
}

function getBody(tests: FlakyTestData[]) {
  let body = `There are multiple flaky tests in ${tests[0].file}. Please investigate and fix the flakiness.\n\n`;
  const platformMapping = tests.reduce((acc, test) => {
    const platforms = getPlatformsAffected(getWorkflowJobNames(test));
    const key = formatTestNameForTitle(test.name, test.suite);
    if (acc.has(key)) {
      const existingPlatforms = acc.get(key) || [];
      acc.set(key, existingPlatforms.concat(platforms));
    }
    acc.set(key, platforms);
    return acc;
  }, new Map<string, string[]>());
  body += formatTestsForBody(platformMapping);
  body += `\nHere is an example for ${tests[0].name} (${tests[0].suite}):\n`;
  body += getIssueBodyForFlakyTest(tests[0]);
  return body;
}

export async function createNewAggregateIssue(
  tests: FlakyTestData[],
  octokit: Octokit
) {
  const title = getTitle(tests[0]);
  let body = getBody(tests);
  const { labels, additionalErrMessage } = await getTestOwnerLabels(tests[0]);
  if (additionalErrMessage) {
    body += `\n\n${additionalErrMessage}`;
  }
  await octokit.rest.issues.create({
    owner: PYTORCH,
    repo: PYTORCH,
    title,
    body,
    labels: labels.concat(
      MASS_FLAKY_TEST_ISSUE_LABEL,
      "module: flaky-tests",
      "skipped"
    ),
  });
}

// MARK: update issue

/**
 * Updates the issue with the given tests.  The issue should be open and the
 * tests should correspond to the matching issue.
 * @param octokit
 * @param matchingIssue
 * @param tests
 */
export async function updateAggregateFlakyTestIssue(
  octokit: Octokit,
  matchingIssue: IssueData,
  tests: FlakyTestData[]
) {
  tests = tests.sort((a, b) => a.name.localeCompare(b.name));
  const { platformMapping: existingPlatformMapping, bodyWithoutPlatforms } =
    parseBody(matchingIssue.body);
  const newPlatformMapping = new Map<string, string[]>();
  const combinedPlatformMapping = new Map<string, string[]>();

  for (const test of tests) {
    const key = formatTestNameForTitle(test.name, test.suite);
    const platforms = getPlatformsAffected(getWorkflowJobNames(test));
    const existingPlatforms = existingPlatformMapping.get(key)!;
    const newPlatforms = platforms.filter(
      (p) => !existingPlatforms.includes(p)
    );
    newPlatformMapping.set(
      key,
      existingPlatforms.length == 0 ? [] : newPlatforms
    );
    combinedPlatformMapping.set(
      key,
      existingPlatforms.length == 0
        ? []
        : newPlatforms.concat(existingPlatforms)
    );
  }

  const testPlatformBodySection = formatTestsForBody(combinedPlatformMapping);
  const newBody = `${testPlatformBodySection}\n${bodyWithoutPlatforms}`;

  const latestTrunkJobURL = getLatestTrunkJobURL(tests[0]);

  let comment = `Another case of trunk flakiness has been found [here](${latestTrunkJobURL}). `;
  if (matchingIssue.state !== "open") {
    comment += `Reopening issue. `;
  }

  const hasNewPlatforms = [...newPlatformMapping]
    .filter(([_, platforms]) => platforms.length > 0)
    .sort((a, b) => a[0].localeCompare(b[0]));

  if (hasNewPlatforms.length > 0) {
    comment += `The lists of platforms does not appear to contain all the recently affected platforms. Adding the following platforms:`;
    comment += `\n${formatPlatformsAffected(newPlatformMapping)}`;
  } else {
    comment +=
      `The lists of platforms appear to contain all the recently affected platforms. ` +
      `Either the change didn't propogate fast enough or disable bot might be broken. `;
  }
  await octokit.rest.issues.createComment({
    owner: PYTORCH,
    repo: PYTORCH,
    issue_number: matchingIssue.number,
    body: comment,
  });
  if (hasNewPlatforms.length > 0) {
    await octokit.rest.issues.update({
      owner: PYTORCH,
      repo: PYTORCH,
      issue_number: matchingIssue.number,
      body: newBody,
    });
  }
}

// MARK: parse issue

function parsePlatformsFromString(s: string) {
  return s
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter((x) => x.length > 0);
}

/**
 * Parse the body of an issue to find all the tests mentioned in code blocks.
 * Might be incorrect if the body gets changed.
 * @param body
 * @returns
 *   - platformMapping: a map of test name to platforms
 *   - bodyWithoutPlatforms: the body without the platforms section
 *   - invalidPlatformMapping: a map of test name to invalid platforms
 *   - failedToParse: a list of tests that failed to parse
 */
function parseBody(body: string) {
  const start = body.toLowerCase().search("disable the following tests:");
  const platformMapping = new Map<string, string[]>();
  const invalidPlatformMapping = new Map<string, string[]>();
  const failedToParse: string[] = [];
  if (start === -1) {
    return {
      platformMapping,
      bodyWithoutPlatforms: body,
      invalidPlatformMapping,
      failedToParse,
    };
  }
  const codeBlock = body.substring(start).split("```")[1];

  const testRegex = new RegExp("(test_[a-zA-Z0-9_]+) \\(([a-zA-Z0-9\\._]+)\\)");
  const possibleTests = codeBlock
    .split("\n")
    .filter((line) => line.trim().length > 0);
  for (const test of possibleTests) {
    const match = test.match(testRegex);
    if (match) {
      const platforms = parsePlatformsFromString(
        test.split(":").length > 1 ? test.split(":")[1] : ""
      );
      const key = `${match[1]} (${match[2]})`;
      const [validPlatforms, invalidPlatforms] = _.partition(
        platforms,
        (platform) => supportedPlatforms.has(platform)
      );
      platformMapping.set(key, validPlatforms);
      if (invalidPlatforms.length > 0) {
        invalidPlatformMapping.set(key, invalidPlatforms);
      }
    } else {
      failedToParse.push(test);
    }
  }
  const bodyWithoutPlatforms =
    body.substring(0, start) +
    body.substring(start).split("```").slice(2).join("```");
  // Remove the platforms section from the body
  return {
    platformMapping,
    bodyWithoutPlatforms,
    invalidPlatformMapping,
    failedToParse,
  };
}

function testMatchesIssue(
  issue: IssueData,
  name: string,
  suite: string
): boolean {
  if (issue.state !== "open") {
    return false;
  }
  const { platformMapping } = parseBody(issue.body);
  const testName = formatTestNameForTitle(name, suite);
  return platformMapping.has(testName);
}

export function matchesAggregateFlakyTestIssue(
  issue: IssueData,
  test: FlakyTestData
): boolean {
  return testMatchesIssue(issue, test.name, test.suite);
}

// MARK: close issue

export function nonFlakyTestMatchesIssue(
  issue: IssueData,
  test: DisabledNonFlakyTestData
): boolean {
  return testMatchesIssue(issue, test.name, test.classname);
}

/**
 * Handle the case where a test is no longer flaky and the issue is still open.
 * If all the tests are no longer flaky, close the issue.  Otherwise, remove the
 * test from the list.  The issue should be open and the tests should correspond
 * to the issue.
 *
 * @param tests
 * @param issue
 * @param octokit
 * @returns
 */
export async function handleNoLongerFlakyTest(
  tests: DisabledNonFlakyTestData[],
  issue: IssueData,
  octokit: Octokit
) {
  const updatedAt = dayjs(issue.updated_at);

  // Only update the issue if the issue is not flaky and hasn't been updated in
  // NUM_HOURS_NOT_UPDATED_BEFORE_CLOSING hours, defaults to 2 weeks
  // Because this is an aggregate issue, it is possible that a few flaky test
  // will block the rest, which might no longer be flaky, from being closed
  if (
    updatedAt.isAfter(
      dayjs().subtract(NUM_HOURS_NOT_UPDATED_BEFORE_CLOSING, "hour")
    )
  ) {
    console.log(
      `Some tests in ${issue.number} is are not flaky but the issue was updated recently`
    );
    return;
  }

  const { platformMapping, bodyWithoutPlatforms } = parseBody(issue.body);
  const noLongerFlakyTestNames = tests.map((test) =>
    formatTestNameForTitle(test.name, test.classname)
  );
  const [noLongerFlaky, stillFlaky] = _.partition(
    Array.from(platformMapping.keys()),
    (key) => noLongerFlakyTestNames.includes(key)
  );

  if (stillFlaky.length > 0) {
    console.log(
      `Some tests in ${issue.number} are not flaky but others are still flaky`
    );
    // Remove the tests from the issue
    const newPlatformMapping = new Map<string, string[]>();
    for (const test of stillFlaky) {
      const platforms = platformMapping.get(test);
      if (platforms) {
        newPlatformMapping.set(test, platforms);
      }
    }
    const testPlatformBodySection = formatTestsForBody(newPlatformMapping);
    const newBody = `${testPlatformBodySection}\n${bodyWithoutPlatforms}`;
    await octokit.rest.issues.update({
      owner: PYTORCH,
      repo: PYTORCH,
      issue_number: issue.number,
      body: newBody,
    });
    const comment = `The following tests were removed from the list because they are no longer flaky: ${noLongerFlaky.join(
      ", "
    )}`;
    await octokit.rest.issues.createComment({
      owner: PYTORCH,
      repo: PYTORCH,
      issue_number: issue.number,
      body: comment,
    });
    return;
  }

  const body =
    `Resolving the issue because the tests are no longer flaky. Please reopen the ` +
    `issue to re-disable the tests if you think this is a false positive`;
  await octokit.rest.issues.createComment({
    owner: PYTORCH,
    repo: PYTORCH,
    issue_number: issue.number,
    body,
  });

  // Close the issue
  await octokit.rest.issues.update({
    owner: PYTORCH,
    repo: PYTORCH,
    issue_number: issue.number,
    state: "closed",
  });
}

// MARK: validation

export function isAggregateIssue(title: string): boolean {
  const prefix = "DISABLED MULTIPLE ";
  return title.startsWith(prefix);
}

export function formValidationComment(
  issue: Context<"issues">["payload"]["issue"],
  authorized: boolean
): string {
  const username = issue.user.login;
  const { platformMapping, invalidPlatformMapping, failedToParse } = parseBody(
    issue.body || ""
  );
  const invalidPlatforms = _.uniq(
    Array.from(invalidPlatformMapping.values()).flat()
  ).sort();

  let body =
    "<body>Hello there! From the DISABLED MUTLIPLE prefix in this issue title, ";
  body += "it looks like you are attempting to disable tests in PyTorch CI. ";
  body += "The information I have parsed is below:\n\n";
  for (const [testName, platforms] of platformMapping.entries()) {
    const platformsToSkip = platforms.length > 0 ? platforms.join(", ") : "all";
    body += `* Test name: \`${testName}\` on platforms: \`${platformsToSkip}\`\n`;
  }
  body += "\n";

  if (invalidPlatforms.length > 0) {
    body += genInvalidPlatformsValidationSection(invalidPlatforms);
  }

  if (!authorized) {
    body += `<b>ERROR!</b> You (${username}) don't have permission to disable these tests.\n\n`;
    body += "</body>";
    return body;
  }

  if (failedToParse.length > 0) {
    body +=
      "<b>ERROR!</b> As you can see above, I could not properly parse the lines:\n";
    body += "```\n";
    body += failedToParse.join("\n");
    body += "\n```\n\n";
    body +=
      "The format I expect is: `test_foo (__main__.TestBar): <platforms list>`.\n\n";
  }

  body += `Within ~15 minutes, the tests listed above will be disabled in CI.`;
  body += `Please verify that the test names and platforms look correct.\n\n`;

  body += "To modify the platforms list, please edit the list of tests. ";
  body +=
    "If no platforms are specified, then it will be disabled on every platform.  \n";
  body += "We currently support the following platforms: ";
  body += `${Array.from(supportedPlatforms.keys())
    .sort((a, b) => a.localeCompare(b))
    .join(", ")}.\n\n`;

  body += genReenableValidationSection(issue.number);

  body += "</body>";
  return body;
}

export const __forTesting__ = {
  getTitle,
  parsePlatformsFromString,
  getBody,
  parseBody,
  formatTestsForBody,
};
