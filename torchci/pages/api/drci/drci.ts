import type { NextApiRequest, NextApiResponse } from "next";
import { getOctokit } from "lib/github";
import { Octokit } from "octokit";
import fetchRecentWorkflows from "lib/fetchRecentWorkflows";
import { RecentWorkflowsData } from "lib/types";
import { NUM_MINUTES, POSSIBLE_USERS, REPO, DRCI_COMMENT_END, formDrciHeader } from "lib/drciUtils";

interface PRandJobs {
    head_sha: string;
    pr_number: number;
    owner_login: string;
    jobs: RecentWorkflowsData[];
}

export default async function handler(
    req: NextApiRequest,
    res: NextApiResponse<void>
) {
    const authorization = req.headers.authorization;
    if (authorization === process.env.DRCI_BOT_KEY) {
        fetchWorkflows();
        res.status(200).end();
    }
    res.status(403).end();
}

export async function fetchWorkflows() {
    const recentWorkflows: RecentWorkflowsData[] = await fetchRecentWorkflows(
        NUM_MINUTES + ""
    );

    const workflowsByPR = reorganizeWorkflows(recentWorkflows);

    for (const [pr_number, pr_info] of workflowsByPR) {
        const { pending, failedJobs } = getWorkflowAnalysis(pr_info);

        const failureInfo = constructFailureAnalysis(pending, failedJobs, pr_info.head_sha);
        const comment = formDrciHeader(pr_number) + failureInfo + DRCI_COMMENT_END;

        updateCommentWithWorkflow(pr_info, comment);
    }
}

export function constructFailureAnalysis(
    pending: number,
    failedJobs: RecentWorkflowsData[],
    sha: string
): string {
    let output = `\n`;
    const failing = failedJobs.length;
    const noneFailing = `## :white_check_mark: No Failures`;
    const someFailing = `## :x: ${failing} Failures`;
    const somePending = `, ${pending} Pending`;

    const hasFailing = failing > 0;
    const hasPending = pending > 0;
    if (!hasFailing) {
        output += noneFailing;
        if (hasPending) {
            output += somePending;
        }
        output += `\nAs of commit ${sha}:`;
        output += `\n:green_heart: Looks good so far! There are no failures yet. :green_heart:`;
    }
    else {
        output += someFailing;
        if (hasPending) {
            output += somePending;
        }
        output += `\nAs of commit ${sha}:`;
        output += '\nThe following jobs have failed:\n';
        for (const job of failedJobs) {
            output += `* [${job.job_name}](${job.html_url})\n`;
        }
    }
    return output;
}

export function getWorkflowAnalysis(
    prInfo: PRandJobs
): { pending: number; failedJobs: RecentWorkflowsData[] } {
    const jobs = prInfo.jobs;
    let numPending = 0;
    const failedJobsInfo: RecentWorkflowsData[] = [];
    for (const workflow of jobs) {
        if (workflow.conclusion === null && workflow.completed_at === null) {
            numPending++;
        }
        else if (workflow.conclusion === "failure") {
            failedJobsInfo.push(workflow);
        }
    }
    return { pending: numPending, failedJobs: failedJobsInfo };
}

export function reorganizeWorkflows(
    recentWorkflows: RecentWorkflowsData[]
): Map<number, PRandJobs> {
    const workflowsByPR = new Map();

    for (const workflow of recentWorkflows) {
        const pr_number = workflow.pr_number!;
        if (workflowsByPR.has(pr_number)) {
            workflowsByPR.get(pr_number).jobs.push(workflow);
        }
        else {
            const new_pr: PRandJobs = {
                head_sha: workflow.head_sha!,
                pr_number: pr_number,
                owner_login: workflow.owner_login!,
                jobs: [workflow]
            };
            workflowsByPR.set(pr_number, new_pr);
        }
    }
    return workflowsByPR;
}

export async function updateCommentWithWorkflow(
    pr_info: PRandJobs,
    comment: string,
): Promise<void> {
    const { pr_number, owner_login } = pr_info;
    if (!POSSIBLE_USERS.includes(owner_login!) || pr_number != 80896) {
        console.log("did not make a comment");
        return;
    }
    const { id, body } = await getDrciComment(
        pr_number!,
        owner_login!,
        REPO
    );

    if (id === 0) {
        return;
    }
    if (body === comment) {
        return;
    }

    const octokit = await getOctokit(owner_login, REPO);
    await octokit.rest.issues.updateComment({
        body: body,
        owner: owner_login!,
        repo: REPO,
        comment_id: id,
    });
}

async function getDrciComment(
    prNum: number,
    owner: string,
    repo: string
): Promise<{ id: number; body: string }> {

    const octokit = await getOctokit(owner, repo);
    const commentsRes = await octokit.rest.issues.listComments({
        owner,
        repo,
        issue_number: prNum,
    });
    for (const comment of commentsRes.data) {
        if (comment.body!.includes(DRCI_COMMENT_END)) {
            return { id: comment.id, body: comment.body! };
        }
    }
    return { id: 0, body: "" };
}
