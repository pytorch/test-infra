import type { NextApiRequest, NextApiResponse } from "next";
import { getOctokit } from "lib/github";
import fetchRecentWorkflows from "lib/fetchRecentWorkflows";
import { RecentWorkflowsData } from "lib/types";
import {
  NUM_MINUTES,
  REPO,
  formDrciComment,
  OWNER,
  getDrciComment,
  getActiveSEVs,
  formDrciSevBody,
} from "lib/drciUtils";
import fetchIssuesByLabel from "lib/fetchIssuesByLabel";

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
        updateDrciComments();
        res.status(200).end();
    }
    res.status(403).end();
}

export async function updateDrciComments() {
    const recentWorkflows: RecentWorkflowsData[] = await fetchRecentWorkflows(
        NUM_MINUTES + ""
    );

    const workflowsByPR = reorganizeWorkflows(recentWorkflows);
    const sevs = getActiveSEVs(await fetchIssuesByLabel("ci: sev"));

    for (const [pr_number, pr_info] of workflowsByPR) {
        const { pending, failedJobs } = getWorkflowJobsStatuses(pr_info);

        const failureInfo = constructResultsComment(pending, failedJobs, pr_info.head_sha);
        const comment = formDrciComment(pr_number, failureInfo, formDrciSevBody(sevs));

        await updateCommentWithWorkflow(pr_info, comment);
    }
}

export function constructResultsComment(
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
        output += '\n<details open><summary>The following jobs have failed:</summary><p>\n\n';
        const failedJobsSorted = failedJobs.sort((a, b) => a.job_name.localeCompare(b.job_name))
        for (const job of failedJobsSorted) {
            output += `* [${job.job_name}](${job.html_url})\n`;
        }
        output += "</p></details>"
    }
    return output;
}

export function getWorkflowJobsStatuses(
    prInfo: PRandJobs
): { pending: number; failedJobs: RecentWorkflowsData[] } {
    const jobs = prInfo.jobs;
    let numPending = 0;
    const jobsInfo: Map<string, RecentWorkflowsData> = new Map();
    for (const workflow of jobs) {
        const jobName = workflow.job_name;
        const runAttempt = workflow.run_attempt;

        if (workflow.conclusion === null && workflow.completed_at === null) {
            numPending++;
        }
        else if (!jobsInfo.has(jobName) || (jobsInfo.get(jobName)!.run_attempt < runAttempt)) {
            // Only keep the latest job run
            jobsInfo.set(jobName, workflow);
        }
    }

    const failedJobsInfo: RecentWorkflowsData[] = [];
    for (const [workflowName, workflow] of jobsInfo) {
        if (workflow.conclusion === "failure") {
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
    const { pr_number } = pr_info;
    const octokit = await getOctokit(OWNER, REPO);
    const { id, body } = await getDrciComment(octokit, OWNER, REPO, pr_number!);

    if (id === 0 || body === comment) {
        return;
    }

    await octokit.rest.issues.updateComment({
        body: comment,
        owner: OWNER,
        repo: REPO,
        comment_id: id,
    });
}
