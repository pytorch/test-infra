import type { NextApiRequest, NextApiResponse } from "next";
import urllib from "urllib";

import { Octokit } from "@octokit/rest";
import fetchFlakyTests from "lib/fetchFlakyTests";
import { FlakyTestData, IssueData } from "lib/types";
import { supportedPlatforms } from "lib/bot/verifyDisableTestIssueBot";
import fetchIssuesByLabel from "lib/fetchIssuesByLabel";

const NUM_HOURS = 6
const octokit = new Octokit();
const owner = "pytorch";
const repo = "pytorch";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<void>
) {
  const flaky_tests = await fetchFlakyTests(`${NUM_HOURS}`);
  const issues: IssueData[] = await fetchIssuesByLabel("skipped");

  flaky_tests.forEach((test: FlakyTestData) => {
    const issueTitle = `DISABLED ${test.name} (${test.suite})`;
    const matchingIssues = issues.filter((issue) => issue.title === issueTitle);

    if (matchingIssues.length !== 0) {
        // There is a matching issue
        const matchingIssue = matchingIssues[0];
        if (matchingIssue.state === "open") {
            const body = `Another case of flakiness has been found [here](${getLatestWorkflowURL(test.workflow_ids)}).
            Please verify the issue was opened after this instance, that the platforms list includes all of
            [${getPlatformsAffected(test.workflow_names).join(", ")}], or disable bot might not be working as expected.`

            octokit.rest.issues.createComment({
                owner,
                repo,
                issue_number: matchingIssue.number,
                body,
            });
        } else {
            // Re-open the issue
            octokit.rest.issues.update({
                owner,
                repo,
                issue_number: matchingIssue.number,
                state: "open",
            });

            const body = `Another case of flakiness has been found [here](${getLatestWorkflowURL(test.workflow_ids)}).
            Reopening the issue to disable. Please verify that the platforms list includes all of
            [${getPlatformsAffected(test.workflow_names).join(", ")}].`

            octokit.rest.issues.createComment({
                owner,
                repo,
                issue_number: matchingIssue.number,
                body,
              });
        }
    } else {
        createIssueFromFlakyTest(test);
    }
  });



  res.status(200);
}

function getLatestWorkflowURL(workflow_ids: string[]): string {
    return `https://github.com/pytorch/pytorch/actions/runs/${workflow_ids[workflow_ids.length - 1]}`
}


function getPlatformsAffected(workflow_names: string[]): string[] {
    let platformsToSkip: string[] = []
    supportedPlatforms.forEach(function(platform: string) {
        workflow_names.forEach(workflow_name => {
            if (workflow_name.includes(platform)) {
                platformsToSkip.push(platform);
            }
        });
    });
    return platformsToSkip;
}


function getIssueBodyForFlakyTest(test: FlakyTestData): string {
    const examplesURL = `http://torch-ci.com/failure/${encodeURIComponent(`${test.name}, ${test.suite}`)}`
    const message = `Platforms: ${getPlatformsAffected(test.workflow_names).join(", ")}

    This test was disabled because it is failing on trunk. See [recent examples](${examplesURL}) and the most recent
    [workflow logs](${getLatestWorkflowURL(test.workflow_ids)}).

    Over the past ${NUM_HOURS} hours, it has been determined flaky in ${test.workflow_ids.length} workflows with
    ${test.num_red} red and ${test.num_green} green.`

    return encodeURIComponent(message);
}


function getTestOwnerLabels(test_file: string) : string[] {
    const urlkey = "https://raw.githubusercontent.com/pytorch/pytorch/master/test/";

    urllib.request(`${urlkey}${test_file}`, function (err, data, res) {
        if (err) {
            console.warn(`Error thrown when attempting to read test file of flaky test: ${err.message}`)
            return ["module: unknown"]
        }
        // TODO: remove the following
        console.log(res.statusCode);
        console.log(res.headers);
        const file_contents = data.toString();  // data is a Buffer
        const lines = file_contents.split(/[\r\n]+/);
        const prefix = "# Owner(s): "
        lines.array.forEach((line: string) => {
            if (line.startsWith(prefix)) {
                const labels: string[] = JSON.parse(line.substring(prefix.length));
                if (labels.length === 0 || (labels.length === 1 && labels[0] === "module: unknown")) {
                    return ["module: unknown"];
                }
                return labels.concat(["triaged"]);
            }
        });
    });
    return ["module: unknown"]
}


function createIssueFromFlakyTest(test: FlakyTestData): void {
    const title = `DISABLED ${test.name} (${test.suite})`;
    const body = getIssueBodyForFlakyTest(test);
    const labels = ["skipped", "module: flaky-tests"].concat(getTestOwnerLabels(test.file));
    octokit.rest.issues.create({
        owner,
        repo,
        title,
        body,
        labels,
    });
}