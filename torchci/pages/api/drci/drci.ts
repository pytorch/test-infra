import { getOctokit } from "lib/github";
import { Octokit } from "octokit";
import fetchRecentWorkflows from "lib/fetchRecentWorkflows";
import { RecentWorkflowsData } from "lib/types";
import * as drciUtils from "lib/drciUtils";

interface PRandJobs {
    head_sha: string;
    pr_number: number;
    owner_login: string;
    jobs: RecentWorkflowsData[];
}

export async function fetchWorkflows() {
    const recentWorkflows: RecentWorkflowsData[] = await fetchRecentWorkflows(
        drciUtils.NUM_MINUTES + ""
    );

    const workflowsByPR = reorganizeWorkflows(recentWorkflows);

    for (const pr of workflowsByPR) {
        const { pending, failedJobs } = getWorkflowAnalysis(pr);
        const failureInfo = constructFailureAnalysis(pending, failedJobs, pr.head_sha);
        //add failureInfo to Dr. CI comment on each PR
    }
}

export function constructFailureAnalysis(
    pending: number,
    failedJobs: RecentWorkflowsData[],
    sha: string
): string {
    let output = ``;
    const failing = failedJobs.length;
    if (failing === 0) {
        output += `## :white_check_mark: No Failures (${pending} Pending})`;
    }
    else if (pending === 0) {
        output += `## :x: ${failing} New Failures`;
    }
    else {
        output += `## :x: ${failing} New Failures, ${pending} Pending`;
    }
    output += `\nAs of commit ${sha}:`;
    if (failing != 0) {
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
    let numFailing = 0;
    let numPending = 0;
    const failedJobsInfo: RecentWorkflowsData[] = [];
    for (const workflow of jobs) {
        if (workflow.conclusion === null && workflow.completed_at === null) {
            numPending++;
        }
        else if (workflow.conclusion === "failure") {
            numFailing++;
            failedJobsInfo.push(workflow);
        }
    }
    return { pending: numPending, failedJobs: failedJobsInfo };
}

export function reorganizeWorkflows(
    recentWorkflows: RecentWorkflowsData[]
): PRandJobs[] {
    const pr_list: number[] = [];
    const workflowsByPR: PRandJobs[] = [];

    for (const workflow of recentWorkflows) {
        const pr_number = workflow.pr_number!;

        if (!pr_list.includes(pr_number)) {
            pr_list.push(pr_number);

            const new_pr: PRandJobs = {
                head_sha: workflow.head_sha!,
                pr_number: pr_number,
                owner_login: workflow.owner_login!,
                jobs: [workflow]
            };
            workflowsByPR.push(new_pr);
        }
        else {
            const objIndex = workflowsByPR.findIndex((obj => obj.pr_number == pr_number));
            workflowsByPR[objIndex].jobs.push(workflow);
        }
    }
    return workflowsByPR;
}

export async function updateCommentWithWorkflow(
    workflow: RecentWorkflowsData,
    octokit: Octokit
): Promise<void> {

    const { pr_number, owner_login } = workflow;
    if (!drciUtils.POSSIBLE_USERS.includes(owner_login!)) {
        console.log("did not make a comment");
        return;
    }
    const { id, body } = await getDrciComment(
        pr_number!,
        owner_login!,
        drciUtils.REPO
    );

    const drciComment = drciUtils.formDrciComment(pr_number!);

    if (id === 0) {
        return;
    }
    if (body === drciComment) {
        return;
    }
    await octokit.rest.issues.updateComment({
        body: body,
        owner: owner_login!,
        repo: drciUtils.REPO,
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
        if (comment.body!.includes(drciUtils.DRCI_COMMENT_START)) {
            return { id: comment.id, body: comment.body! };
        }
    }
    return { id: 0, body: "" };
}
