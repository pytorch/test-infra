import dayjs from "dayjs";
import fetchDisabledNonFlakyTests from "lib/fetchDisabledNonFlakyTests";
import fetchFlakyTests, {
  fetchFlakyTestsAcrossFileReruns,
} from "lib/fetchFlakyTests";
import fetchIssuesByLabel from "lib/fetchIssuesByLabel";
import * as aggregateDisableIssue from "lib/flakyBot/aggregateDisableIssue";
import * as singleDisableIssue from "lib/flakyBot/singleDisableIssue";
import { getOctokit } from "lib/github";
import { DisabledNonFlakyTestData, FlakyTestData, IssueData } from "lib/types";
import _ from "lodash";
import type { NextApiRequest, NextApiResponse } from "next";
import { Octokit } from "octokit";

export const NUM_HOURS = 6;
const PYTORCH = "pytorch";
const THRESHOLD = 4;

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

  // Separating this out to make it easier to test
  await handleAll(
    octokit,
    flakyTests,
    flakyTestsAcrossFileReruns,
    issues,
    disabledNonFlakyTests
  );
}

async function handleAll(
  octokit: Octokit,
  flakyTests: FlakyTestData[],
  flakyTestsAcrossFileReruns: FlakyTestData[],
  issues: IssueData[],
  disabledNonFlakyTests: DisabledNonFlakyTestData[]
) {
  const allFlakyTests = flakyTests.concat(flakyTestsAcrossFileReruns);
  allFlakyTests.forEach((test) => {
    test.invoking_file = test.invoking_file.replaceAll(".", "/");
  });
  // If the test is flaky only on PRs, we should not disable it yet.
  const recentFlakyTests = allFlakyTests.filter((test) => wasRecent(test));
  const flakyTestsOnTrunk = filterThreshold(
    filterOutPRFlakyTests(recentFlakyTests)
  );

  const dedupedIssues = await dedupFlakyTestIssues(octokit, issues);

  await handleFlakyTests(flakyTestsOnTrunk, dedupedIssues, octokit);

  // Get the list of non-flaky tests, the list of all flaky tests is used to guarantee
  // that no flaky test is accidentally closed
  const nonFlakyTests = filterOutNonFlakyTests(
    disabledNonFlakyTests,
    allFlakyTests
  );

  await handleNoLongerFlakyTests(nonFlakyTests, dedupedIssues, octokit);
}

function filterOutPRFlakyTests(tests: FlakyTestData[]): FlakyTestData[] {
  // Remove the PR-only instances of flakiness, but don't modify data within
  return tests.filter(
    (test) => test.branches.includes("master") || test.branches.includes("main")
  );
}
function filterThreshold(
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

async function handleFlakyTests(
  flakyTests: FlakyTestData[],
  issues: IssueData[],
  octokit: Octokit
) {
  // Determine the test 1. has a matching single issue, 2. has a matching
  // aggregate issue, 3. needs a new single issue, 4. needs a new aggregate
  // issue
  const stillLeft = (
    await Promise.all(
      flakyTests.map(async (test) => {
        for (const issue of issues) {
          if (singleDisableIssue.matchesSingleFlakyTestIssue(issue, test)) {
            await singleDisableIssue.updateExistingIssueForFlakyTest(
              octokit,
              issue,
              test
            );
            return { test, keep: false };
          }
        }

        return { test, keep: true };
      })
    )
  )
    .filter((x) => x.keep)
    .map((x) => x.test);

  // Map issue number -> tests that should update it
  const aggregateIssueToBeUpdated = new Map<string, FlakyTestData[]>();

  const needsNew = stillLeft.filter((test) => {
    for (const issue of issues) {
      if (aggregateDisableIssue.matchesAggregateFlakyTestIssue(issue, test)) {
        aggregateIssueToBeUpdated.set(
          issue.number.toString(),
          (aggregateIssueToBeUpdated.get(issue.number.toString()) || []).concat(
            [test]
          )
        );
        return false;
      }
    }
    return true;
  });

  for (const [issueNumber, tests] of aggregateIssueToBeUpdated.entries()) {
    const issue = issues.find(
      (issue) => issue.number.toString() === issueNumber
    )!;
    await aggregateDisableIssue.updateAggregateFlakyTestIssue(
      octokit,
      issue,
      tests
    );
  }

  const groupedByFile = _.groupBy(needsNew, (test) => test.file);

  for (const file in groupedByFile) {
    let tests = groupedByFile[file];
    tests = tests.sort((a, b) => a.name.localeCompare(b.name));

    if (tests.length > THRESHOLD) {
      await aggregateDisableIssue.createNewAggregateIssue(tests, octokit);
    } else {
      for (const test of tests) {
        await singleDisableIssue.createNewSingleIssue(test, octokit);
      }
    }
  }
}

function filterOutNonFlakyTests(
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

async function dedupFlakyTestIssues(
  octokit: Octokit,
  issues: IssueData[]
): Promise<IssueData[]> {
  // Dedup the list of issues by favoring open issues and issues with the
  // largest PR number.

  let deduped = new Map<string, IssueData>();
  const [aggregateIssues, singleIssues] = _.partition(issues, (issue) =>
    issue.labels.includes(aggregateDisableIssue.MASS_FLAKY_TEST_ISSUE_LABEL)
  );

  for (const issue of singleIssues) {
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
  for (const issue of singleIssues) {
    if (!dedupedArrayNumbers.includes(issue.number) && issue.state === "open") {
      await octokit.rest.issues.update({
        owner: PYTORCH,
        repo: PYTORCH,
        issue_number: issue.number,
        state: "closed",
      });
    }
  }

  return dedupedArray.concat(aggregateIssues);
}

async function handleNoLongerFlakyTests(
  tests: DisabledNonFlakyTestData[],
  issues: IssueData[],
  octokit: Octokit
) {
  const openIssues = issues.filter((issue) => issue.state === "open");

  // Sort the tests by the issues they should update.
  // Map issue number -> tests that should update it
  const singleIssueToBeUpdated = new Map<string, DisabledNonFlakyTestData[]>();
  const aggregateIssueToBeUpdated = new Map<
    string,
    DisabledNonFlakyTestData[]
  >();

  for (const test of tests) {
    for (const issue of openIssues) {
      if (singleDisableIssue.nonFlakyTestMatchesIssue(issue, test)) {
        singleIssueToBeUpdated.set(
          issue.number.toString(),
          (singleIssueToBeUpdated.get(issue.number.toString()) || []).concat([
            test,
          ])
        );
      }
      if (aggregateDisableIssue.nonFlakyTestMatchesIssue(issue, test)) {
        aggregateIssueToBeUpdated.set(
          issue.number.toString(),
          (aggregateIssueToBeUpdated.get(issue.number.toString()) || []).concat(
            [test]
          )
        );
      }
    }
  }

  for (const [issueNumber, tests] of singleIssueToBeUpdated) {
    const issue = openIssues.find(
      (issue) => issue.number.toString() === issueNumber
    );
    if (issue) {
      await singleDisableIssue.handleNoLongerFlakyTest(
        tests[0],
        issue,
        octokit
      );
    }
  }
  for (const [issueNumber, tests] of aggregateIssueToBeUpdated) {
    const issue = openIssues.find(
      (issue) => issue.number.toString() === issueNumber
    );
    if (issue) {
      await aggregateDisableIssue.handleNoLongerFlakyTest(
        tests,
        issue,
        octokit
      );
    }
  }
}

function wasRecent(test: FlakyTestData) {
  if (test.eventTimes) {
    return test.eventTimes.some(
      (value) => dayjs().diff(dayjs(value), "minutes") < (NUM_HOURS - 1) * 60
    );
  }
  return true;
}

export const __forTesting__ = {
  handleNoLongerFlakyTests,
  filterOutPRFlakyTests,
  filterOutNonFlakyTests,
  dedupFlakyTestIssues,
  handleAll,
};
