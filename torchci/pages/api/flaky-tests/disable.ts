import type { NextApiRequest, NextApiResponse } from "next";
import { getOctokit } from "lib/github";
import fetchFlakyTests, {
  fetchFlakyTestsAcrossJobs,
  fetchFlakyTestsAcrossFileReruns,
} from "lib/fetchFlakyTests";
import fetchDisabledNonFlakyTests from "lib/fetchDisabledNonFlakyTests";
import { FlakyTestData, IssueData, DisabledNonFlakyTestData } from "lib/types";
import {
  parseBody,
  supportedPlatforms,
} from "lib/bot/verifyDisableTestIssueBot";
import fetchIssuesByLabel from "lib/fetchIssuesByLabel";
import { retryRequest } from "lib/bot/utils";
import { Octokit } from "octokit";
import dayjs from "dayjs";
import _ from "lodash";

const NUM_HOURS = 3;
const NUM_HOURS_ACROSS_JOBS = 72;
export const NUM_HOURS_NOT_UPDATED_BEFORE_CLOSING = 24 * 14; // 2 weeks
const owner: string = "pytorch";
const repo: string = "pytorch";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<void>
) {
  const authorization = req.headers.authorization;
  if (authorization === process.env.FLAKY_TEST_BOT_KEY) {
    await disableFlakyTestsAndReenableNonFlakyTests();
    res.status(200).end();
  }
  res.status(403).end();
}

async function disableFlakyTestsAndReenableNonFlakyTests() {
  const [
    octokit,
    flakyTests,
    flakyTestsAcrossFileReruns,
    issues,
    disabledNonFlakyTests,
  ] = await Promise.all([
    getOctokit(owner, repo),
    fetchFlakyTests(`${NUM_HOURS}`),
    fetchFlakyTestsAcrossFileReruns(`${NUM_HOURS}`),
    fetchIssuesByLabel("skipped"),
    fetchDisabledNonFlakyTests(),
  ]);

  const allFlakyTests = flakyTests.concat(flakyTestsAcrossFileReruns);
  // If the test is flaky only on PRs, we should not disable it yet.
  const flakyTestsOnTrunk = filterThreshold(
    filterOutPRFlakyTests(allFlakyTests)
  );

  const dedupedIssues = await dedupFlakyTestIssues(octokit, issues);

  flakyTestsOnTrunk.forEach(async function (test) {
    await handleFlakyTest(test, dedupedIssues, octokit);
  });

  // Get the list of non-flaky tests, the list of all flaky tests is used to guarantee
  // that no flaky test is accidentally closed
  const nonFlakyTests = filterOutNonFlakyTests(
    disabledNonFlakyTests,
    allFlakyTests
  );

  nonFlakyTests.forEach(async function (test) {
    await handleNonFlakyTest(test, issues, octokit);
  });
}

export function filterOutPRFlakyTests(tests: FlakyTestData[]): FlakyTestData[] {
  // Remove the PR-only instances of flakiness, but don't modify data within
  return tests.filter(
    (test) => test.branches.includes("master") || test.branches.includes("main")
  );
}

export function filterThreshold(
  tests: FlakyTestData[],
  threshold: number = 1
): FlakyTestData[] {
  return tests.filter((test) => new Set(test.jobIds).size > threshold);
}

export async function handleAnotherCaseOfFlakiness(
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
    owner,
    repo,
    issue_number: matchingIssue.number,
    body: comment,
  });
  if (newBody !== undefined || matchingIssue.state !== "open") {
    await octokit.rest.issues.update({
      owner,
      repo,
      issue_number: matchingIssue.number,
      body: newBody,
      state: "open",
    });
  }
}

export async function handleFlakyTest(
  test: FlakyTestData,
  issues: IssueData[],
  octokit: Octokit
) {
  const issueTitle = getIssueTitle(test.name, test.suite);
  const matchingIssues = issues.filter((issue) => issue.title === issueTitle);
  const workflowJobNames = getWorkflowJobNames(test);
  test.invoking_file = test.invoking_file.replaceAll(".", "/");
  if (matchingIssues.length !== 0) {
    // There is a matching issue
    const matchingIssue = matchingIssues[0];
    if (!wasRecent(test)) {
      return;
    }
    await handleAnotherCaseOfFlakiness(octokit, matchingIssue, test);
  } else {
    await createIssueFromFlakyTest(test, octokit);
  }
}

export function filterOutNonFlakyTests(
  nonFlakyTests: DisabledNonFlakyTestData[],
  allFlakyTests: FlakyTestData[]
): DisabledNonFlakyTestData[] {
  const flakyTestKeys = allFlakyTests.map(
    (test) => `${test.name} / ${test.suite}`
  );

  return nonFlakyTests.filter(
    (test) => !flakyTestKeys.includes(`${test.name} / ${test.classname}`)
  );
}

export async function dedupFlakyTestIssues(
  octokit: Octokit,
  issues: IssueData[]
): Promise<IssueData[]> {
  // Dedup the list of issues by favoring open issues and issues with the
  // largest PR number.

  let deduped = new Map<string, IssueData>();

  for (const issue of issues) {
    const key = issue.title;
    const existing_issue = deduped.get(key);
    if (
      !existing_issue ||
      (issue.state === existing_issue.state &&
        issue.number > existing_issue.number) ||
      (existing_issue.state === "closed" && issue.state === "open")
    ) {
      deduped.set(key, issue);
    }
  }
  const dedupedArray = Array.from(deduped.values());

  // Close the issues that aren't favored
  const dedupedArrayNumbers = dedupedArray.map((i) => i.number);
  for (const issue of issues) {
    if (!dedupedArrayNumbers.includes(issue.number) && issue.state === "open") {
      await octokit.rest.issues.update({
        owner,
        repo,
        issue_number: issue.number,
        state: "closed",
      });
    }
  }
  return dedupedArray;
}

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
      owner,
      repo,
      issue_number: matchingIssue.number,
      body,
    });

    // Close the issue
    await octokit.rest.issues.update({
      owner,
      repo,
      issue_number: matchingIssue.number,
      state: "closed",
    });
  }
}

export function getLatestTrunkJobURL(test: FlakyTestData): string {
  let index = test.branches.lastIndexOf("master");
  if (index < 0) {
    index = test.branches.lastIndexOf("main");
    if (index < 0) {
      console.warn(
        `Flaky test ${test.name} has no trunk failures. Disabling anyway, but this may be unintended.`
      );
      index = test.workflowIds.length - 1;
    }
  }
  return `https://github.com/pytorch/pytorch/runs/${test.jobIds[index]}`;
}

export function getIssueTitle(testName: string, testSuite: string) {
  let suite = testSuite;
  // If the test class is not a subclass, it belongs to __main__
  if (testSuite.indexOf(".") < 0) {
    suite = "__main__." + suite;
  }
  return `DISABLED ${testName} (${suite})`;
}

export function getWorkflowJobNames(test: FlakyTestData): string[] {
  return test.workflowNames.map(
    (value, index) => `${value} / ${test.jobNames[index]}`
  );
}

export function getPlatformsAffected(workflowJobNames: string[]): string[] {
  const platformsToSkip: string[] = [];
  Array.from(supportedPlatforms.keys()).forEach((platform: string) =>
    workflowJobNames.forEach((workflowJobNames) => {
      if (
        workflowJobNames.includes(platform) &&
        (platform == "rocm" || !workflowJobNames.includes("rocm")) &&
        !workflowJobNames.includes("dynamo") &&
        !workflowJobNames.includes("inductor") &&
        !platformsToSkip.includes(platform)
      ) {
        platformsToSkip.push(platform);
      }
    })
  );

  // dynamo and inductor are subsets of linux, so only include them if linux is
  // not present as a disable platform
  if (!platformsToSkip.includes("linux")) {
    if (workflowJobNames.some((name) => name.includes("dynamo"))) {
      platformsToSkip.push("dynamo");
    }
    if (workflowJobNames.some((name) => name.includes("inductor"))) {
      platformsToSkip.push("inductor");
    }
  }

  return platformsToSkip;
}

export function getIssueBodyForFlakyTest(test: FlakyTestData): string {
  let examplesURL = `https://hud.pytorch.org/flakytest?name=${test.name}&suite=${test.suite}`;
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
  if (test.numRed === undefined) {
    // numRed === undefined indicates that is from the 'flaky_tests_across_jobs' query
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

${fileInfo}`;
}

export async function getTestOwnerLabels(
  test: FlakyTestData
): Promise<{ labels: string[]; additionalErrMessage?: string }> {
  const urlkey = "https://raw.githubusercontent.com/pytorch/pytorch/main/test/";

  let labels: string[] = [];
  let additionalErrMessage = undefined;

  try {
    let result = await retryRequest(`${urlkey}${test.file}`);
    let statusCode = result.res.statusCode;
    if (statusCode !== 200) {
      result = await retryRequest(`${urlkey}${test.invoking_file}.py`);
      if (result.res.statusCode !== 200) {
        throw new Error(
          `Error retrieving ${test.file}: ${statusCode}, ${test.invoking_file}: ${result.res.statusCode}`
        );
      }
    }
    const fileContents = result.data.toString(); // data is a Buffer
    const lines = fileContents.split(/[\r\n]+/);
    const prefix = "# Owner(s): ";
    for (const line of lines) {
      if (line.startsWith(prefix)) {
        labels = labels.concat(JSON.parse(line.substring(prefix.length)));
        break;
      }
    }
    console.log(labels);
  } catch (err) {
    console.warn(err);
    additionalErrMessage = `${err}`;
  }

  labels.push(
    ...getPlatformLabels(getPlatformsAffected(getWorkflowJobNames(test)))
  );

  if (labels.length === 0) {
    labels.push("module: unknown");
  }

  if (labels.some((x) => x.startsWith("module: ") && x !== "module: unknown")) {
    labels.push("triaged");
  }
  return { labels, additionalErrMessage };
}

export function getPlatformLabels(platforms: string[]): string[] {
  let labels = undefined;
  for (const platform of platforms) {
    if (labels === undefined) {
      labels = supportedPlatforms.get(platform);
    } else if (!_.isEqual(supportedPlatforms.get(platform), labels)) {
      return [];
    }
  }
  return labels ?? [];
}

export function wasRecent(test: FlakyTestData) {
  if (test.eventTimes) {
    return test.eventTimes.some(
      (value) => dayjs().diff(dayjs(value), "minutes") < NUM_HOURS * 60
    );
  }
  return true;
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
    owner,
    repo,
    title,
    body,
    labels: ["skipped", "module: flaky-tests"].concat(labels),
  });
}
