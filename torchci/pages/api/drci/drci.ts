import type { NextApiRequest, NextApiResponse } from "next";
import { getOctokit } from "lib/github";
import { Octokit } from "octokit";
import fetchRecentWorkflows from "lib/fetchRecentWorkflows";
import { RecentWorkflowsData } from "lib/types";

const NUM_MINUTES = 15;
const repo: string = "pytorch";
export const drciCommentStart = "<!-- drci-comment-start -->\n";
export const officeHoursUrl =
  "https://github.com/pytorch/pytorch/wiki/Dev-Infra-Office-Hours";
export const docsBuildsUrl = "https://docs-preview.pytorch.org/";
export const pythonDocsUrl = "/index.html";
export const cppDocsUrl = "/cppdocs/index.html";
const drciCommentEnd = "\n<!-- drci-comment-end -->";
const possibleUsers = ["swang392"];
const hudUrl = "https://hud.pytorch.org/pr/";


export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<void>
) {
    let numMinutes = NUM_MINUTES + "";

    const recentWorkflows: RecentWorkflowsData[] = await fetchRecentWorkflows(
        numMinutes
    );
}

export async function updateCommentWithWorkflow(
    workflow: RecentWorkflowsData,
    octokit: Octokit
): Promise<void> {

    //not sure how to get current pr owner -- for now this works since comments only exist on swang392's PRs
    const prNum = workflow.pr_number;
    const owner = workflow.owner_login;
    const existingDrciData = await getDrciComment(
        prNum,
        owner,
        repo
      );
    
    const existingDrciID = existingDrciData.id;
    const existingDrciComment = existingDrciData.body;
    const drciComment = formDrciComment(prNum);

    if (existingDrciID == 0) {
        return;
    }
    if (existingDrciComment == drciComment) {
        return;
    }
    await octokit.rest.issues.updateComment({
        body: drciComment,
        owner,
        repo,
        comment_id: existingDrciID,
    });
}

async function getDrciComment(
    prNum: number,
    owner: string,
    repo: string
    ): Promise<{ id: number; body: string }> {
    
    const octokit = getOctokit(owner, repo);
    const commentsRes = (await octokit).rest.issues.listComments({
        owner,
        repo,
        issue_number: prNum,
    });
    for (const comment of (await commentsRes).data) {
        if (comment.body!.includes(drciCommentStart)) {
        return { id: comment.id, body: comment.body! };
        }
    }
    return { id: 0, body: "" };
}

export function formDrciComment(prNum: number): string {
    let body = `## :link: Helpful Links
### :test_tube: See artifacts and rendered test results [here](${hudUrl}${prNum})
* :page_facing_up: Preview [Python docs built from this PR](${docsBuildsUrl}${prNum}${pythonDocsUrl})
* :page_facing_up: Preview [C++ docs built from this PR](${docsBuildsUrl}${prNum}${cppDocsUrl})
* :question: Need help or want to give feedback on the CI? Visit our [office hours](${officeHoursUrl})
Note: Links to docs will display an error until the docs builds have been completed.`;
    return drciCommentStart + body + drciCommentEnd;
  }

