import type { NextApiRequest, NextApiResponse } from "next";
import { getOctokit } from "lib/github";
import fetchFlakyTests, {
  fetchFlakyTestsAcrossJobs,
} from "lib/fetchFlakyTests";
import fetchDisabledNonFlakyTests from "lib/fetchDisabledNonFlakyTests";
import { FlakyTestData, IssueData, DisabledNonFlakyTestData } from "lib/types";
import { supportedPlatforms } from "lib/bot/verifyDisableTestIssueBot";
import fetchIssuesByLabel from "lib/fetchIssuesByLabel";
import { retryRequest } from "lib/bot/utils";
import { Octokit } from "octokit";
import dayjs from "dayjs";

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
    flakyTestsAcrossJobs,
    issues,
    disabledNonFlakyTests,
  ] = await Promise.all([
    getOctokit(owner, repo),
    fetchFlakyTests(`${NUM_HOURS}`),
    fetchFlakyTestsAcrossJobs(`${NUM_HOURS_ACROSS_JOBS}`), // use a larger time window so we can get more data
    fetchIssuesByLabel("skipped"),
    fetchDisabledNonFlakyTests(),
  ]);

  const allFlakyTests = flakyTests.concat(flakyTestsAcrossJobs);
  // If the test is flaky only on PRs, we should not disable it yet.
  const flakyTestsOnTrunk = filterThreshold(
    filterOutPRFlakyTests(allFlakyTests)
  );

  flakyTestsOnTrunk.forEach(async function (test) {
    await handleFlakyTest(test, issues, octokit);
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

export async function handleFlakyTest(
  test: FlakyTestData,
  issues: IssueData[],
  octokit: Octokit
) {
  const issueTitle = getIssueTitle(test.name, test.suite);
  const matchingIssues = issues.filter((issue) => issue.title === issueTitle);
  const workflowJobNames = getWorkflowJobNames(test);
  if (matchingIssues.length !== 0) {
    // There is a matching issue
    const matchingIssue = matchingIssues[0];
    if (!wasRecent(test)) {
      return;
    }
    if (matchingIssue.state === "open") {
      const body = `Another case of trunk flakiness has been found [here](${getLatestTrunkJobURL(
        test
      )}).
            Please verify the issue was opened after this instance, that the platforms list includes all of
            [${getPlatformsAffected(workflowJobNames).join(
              ", "
            )}], or disable bot might not be working as expected.`;
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: matchingIssue.number,
        body,
      });
    } else {
      // Re-open the issue
      await octokit.rest.issues.update({
        owner,
        repo,
        issue_number: matchingIssue.number,
        state: "open",
      });

      const body = `Another case of trunk flakiness has been found [here](${getLatestTrunkJobURL(
        test
      )}).
            Reopening the issue to disable. Please verify that the platforms list includes all of
            [${getPlatformsAffected(workflowJobNames).join(", ")}].`;
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: matchingIssue.number,
        body,
      });
    }
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
    let index = test.branches.lastIndexOf("main");
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
  supportedPlatforms.forEach((platform: string) =>
    workflowJobNames.forEach((workflowJobNames) => {
      if (
        workflowJobNames.includes(platform) &&
        (platform == "rocm" || !workflowJobNames.includes("rocm")) &&
        (platform == "dynamo" || !workflowJobNames.includes("dynamo")) &&
        (platform == "inductor" || !workflowJobNames.includes("inductor")) &&
        !platformsToSkip.includes(platform)
      ) {
        platformsToSkip.push(platform);
      }
    })
  );
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
    fileInfo += ` or \`${test.file}\``;
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
  testFile: string,
  invokingFile: string
): Promise<{ labels: string[]; additionalErrMessage?: string }> {
  const urlkey = "https://raw.githubusercontent.com/pytorch/pytorch/main/test/";

  try {
    let result = await retryRequest(`${urlkey}${testFile}`);
    let statusCode = result.res.statusCode;
    if (statusCode !== 200) {
      const invokingFileClean = invokingFile.replaceAll(".", "/");
      result = await retryRequest(`${urlkey}${invokingFileClean}.py`);
      if (result.res.statusCode !== 200) {
        throw new Error(
          `Error retrieving ${testFile}: ${statusCode}, ${invokingFileClean}: ${result.res.statusCode}`
        );
      }
    }
    const fileContents = result.data.toString(); // data is a Buffer
    const lines = fileContents.split(/[\r\n]+/);
    const prefix = "# Owner(s): ";
    for (const line of lines) {
      if (line.startsWith(prefix)) {
        const labels: string[] = JSON.parse(line.substring(prefix.length));
        if (labels.length === 0) {
          return { labels: ["module: unknown"] };
        }
        if (
          labels.some(
            (x) => x.startsWith("module: ") && x !== "module: unknown"
          )
        ) {
          labels.push("triaged");
        }
        return { labels: labels };
      }
    }
    return { labels: ["module: unknown"] };
  } catch (err) {
    console.warn(err);
    return {
      labels: ["module: unknown"],
      additionalErrMessage: `${err}`,
    };
  }
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
  const { labels, additionalErrMessage } = await getTestOwnerLabels(
    test.file,
    test.invoking_file
  );
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
