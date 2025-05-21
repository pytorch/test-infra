import dayjs from "dayjs";
import fetchDisabledNonFlakyTests from "lib/fetchDisabledNonFlakyTests";
import fetchFlakyTests, {
  fetchFlakyTestsAcrossFileReruns,
} from "lib/fetchFlakyTests";
import fetchIssuesByLabel from "lib/fetchIssuesByLabel";
import * as singleDisableIssue from "lib/flakyBot/singleDisableIssue";
import { getOctokit } from "lib/github";
import { DisabledNonFlakyTestData, FlakyTestData, IssueData } from "lib/types";
import type { NextApiRequest, NextApiResponse } from "next";
import { Octokit } from "octokit";

export const NUM_HOURS = 3;

const PYTORCH = "pytorch";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<void>
) {
  const authorization = req.headers.authorization;
  if (authorization === process.env.FLAKY_TEST_BOT_KEY) {
    await disableFlakyTestsAndReenableNonFlakyTests();
    res.status(200).end();
  } else {
    res.status(403).end();
  }
}

async function disableFlakyTestsAndReenableNonFlakyTests() {
  const [
    octokit,
    flakyTests,
    flakyTestsAcrossFileReruns,
    issues,
    disabledNonFlakyTests,
  ] = await Promise.all([
    getOctokit(PYTORCH, PYTORCH),
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
    await singleDisableIssue.handleNonFlakyTest(test, issues, octokit);
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
  threshold: number = 2
): FlakyTestData[] {
  return tests.filter(
    (test) =>
      new Set(test.jobIds).size > threshold &&
      test.suite != "TestSDPACudaOnlyCUDA" && // TODO: Get rid of this when driss fixes the flakiness
      !(
        test.suite == "TestInductorOpInfoCPU" &&
        test.jobNames.every((name) => name.includes("mac"))
      ) // See https://github.com/pytorch/pytorch/issues/135885
  );
}

export async function handleFlakyTest(
  test: FlakyTestData,
  issues: IssueData[],
  octokit: Octokit
) {
  const issueTitle = singleDisableIssue.getIssueTitle(test.name, test.suite);
  const matchingIssues = issues.filter((issue) => issue.title === issueTitle);
  test.invoking_file = test.invoking_file.replaceAll(".", "/");
  if (matchingIssues.length !== 0) {
    // There is a matching issue
    const matchingIssue = matchingIssues[0];
    if (!wasRecent(test)) {
      return;
    }
    await singleDisableIssue.updateExistingIssueForFlakyTest(
      octokit,
      matchingIssue,
      test
    );
  } else {
    await singleDisableIssue.createIssueFromFlakyTest(test, octokit);
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
        owner: PYTORCH,
        repo: PYTORCH,
        issue_number: issue.number,
        state: "closed",
      });
    }
  }
  return dedupedArray;
}

export function wasRecent(test: FlakyTestData) {
  if (test.eventTimes) {
    return test.eventTimes.some(
      (value) => dayjs().diff(dayjs(value), "minutes") < NUM_HOURS * 60
    );
  }
  return true;
}
