import type { NextApiRequest, NextApiResponse } from "next";
import * as urllib from "urllib";

import { getOctokit } from "lib/github";
import fetchFlakyTests from "lib/fetchFlakyTests";
import { FlakyTestData, IssueData } from "lib/types";
import { supportedPlatforms } from "lib/bot/verifyDisableTestIssueBot";
import fetchIssuesByLabel from "lib/fetchIssuesByLabel";
import { Octokit } from "octokit";


const NUM_HOURS = 3;
const owner: string = "pytorch";
const repo: string = "pytorch";


export default async function handler(
    req: NextApiRequest,
    res: NextApiResponse<void>
) {
    const authorization = req.headers.authorization;
    if (authorization === process.env.FLAKY_TEST_BOT_KEY) {
        await disableFlakyTests();
        res.status(200).end();
    }
    res.status(403).end();
}


async function disableFlakyTests() {
    const [octokit, flaky_tests, issues] = await Promise.all([
        getOctokit(owner, repo), fetchFlakyTests(`${NUM_HOURS}`), fetchIssuesByLabel("skipped")]);

    // If the test is flaky only on PRs, we should not disable it yet.
    const flaky_tests_on_trunk = filterOutPRFlakyTests(flaky_tests);

    flaky_tests_on_trunk.forEach(async function (test) {
        await handleFlakyTest(test, issues, octokit);
    });
}


export function filterOutPRFlakyTests(tests: FlakyTestData[]) : FlakyTestData[] {
    // Remove the PR-only instances of flakiness, but don't modify data within
    return tests.filter(test => test.branches.includes("master"));
}


export async function handleFlakyTest(test: FlakyTestData, issues: IssueData[], octokit: Octokit) {
    const issueTitle = getIssueTitle(test.name, test.suite);
    const matchingIssues = issues.filter((issue) => issue.title === issueTitle);
    if (matchingIssues.length !== 0) {
        // There is a matching issue
        const matchingIssue = matchingIssues[0];
        if (matchingIssue.state === "open") {
            const body = `Another case of trunk flakiness has been found [here](${getLatestTrunkWorkflowURL(test)}).
            Please verify the issue was opened after this instance, that the platforms list includes all of
            [${getPlatformsAffected(test.workflow_names).join(", ")}], or disable bot might not be working as expected.`;
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

            const body = `Another case of trunk flakiness has been found [here](${getLatestTrunkWorkflowURL(test)}).
            Reopening the issue to disable. Please verify that the platforms list includes all of
            [${getPlatformsAffected(test.workflow_names).join(", ")}].`;
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


export function getLatestTrunkWorkflowURL(test: FlakyTestData): string {
    let index = test.branches.lastIndexOf("master");
    if (index < 0) {
        console.warn(`Flaky test ${test.name} has no trunk failures. Disabling anyway, but this may be unintended.`);
        index = test.workflow_ids.length - 1;
    }
    return `https://github.com/pytorch/pytorch/actions/runs/${test.workflow_ids[index]}`;
}


export function getIssueTitle(test_name: string, test_suite: string) {
    let suite = test_suite;
    // If the test class is not a subclass, it belongs to __main__
    if (test_suite.indexOf(".") < 0) {
        suite = "__main__." + suite;
    }
    return `DISABLED ${test_name} (${suite})`;
}


export function getPlatformsAffected(workflow_names: string[]): string[] {
    const platformsToSkip: string[] = [];
    supportedPlatforms.forEach((platform: string) =>
        workflow_names.forEach(workflow_name => {
            if (workflow_name.includes(platform) && !platformsToSkip.includes(platform)) {
                platformsToSkip.push(platform);
            }
        })
    );
    return platformsToSkip;
}


export function getIssueBodyForFlakyTest(test: FlakyTestData): string {
    const examplesURL = `http://torch-ci.com/failure/${encodeURIComponent(`${test.name}, ${test.suite}`)}`;
    return `Platforms: ${getPlatformsAffected(test.workflow_names).join(", ")}

This test was disabled because it is failing in CI. See [recent examples](${examplesURL}) and the most recent trunk [workflow logs](${getLatestTrunkWorkflowURL(test)}).

Over the past ${NUM_HOURS} hours, it has been determined flaky in ${test.workflow_ids.length} workflow(s) with ${test.num_red} red and ${test.num_green} green.`;
}


export async function getTestOwnerLabels(test_file: string) : Promise<string[]> {
    const urlkey = "https://raw.githubusercontent.com/pytorch/pytorch/master/test/";

    try {
        const result = await urllib.request(`${urlkey}${test_file}.py`);
        const status_code = result.res.statusCode;
        if (status_code !== 200) {
            console.warn(`Error retrieving test file of flaky test: ${status_code}`);
            return ["module: unknown"];
        }
        const file_contents = result.data.toString();  // data is a Buffer
        const lines = file_contents.split(/[\r\n]+/);
        const prefix = "# Owner(s): ";
        for (const line of lines) {
            if (line.startsWith(prefix)) {
                const labels: string[] = JSON.parse(line.substring(prefix.length));
                if (labels.length === 0 || (labels.length === 1 && labels[0] === "module: unknown")) {
                    return ["module: unknown"];
                }
                if (labels.length === 1 && labels[0] === "high priority") {
                    return ["high priority"];
                }
                return labels.concat(["triaged"]);
            }
        }
        return ["module: unknown"];
    } catch (err) {
        console.warn(`Error retrieving test file of flaky test: ${err}`);
        return ["module: unknown"];
    }
}


export async function createIssueFromFlakyTest(test: FlakyTestData, octokit: Octokit): Promise<void> {
    const title = getIssueTitle(test.name, test.suite);
    const body = getIssueBodyForFlakyTest(test);
    const labels = ["skipped", "module: flaky-tests"].concat(await getTestOwnerLabels(test.file));
    await octokit.rest.issues.create({
        owner,
        repo,
        title,
        body,
        labels,
    });
}
