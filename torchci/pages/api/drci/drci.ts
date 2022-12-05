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
import { Octokit } from "octokit";

interface PRandJobs {
    sha: string;
    pr_number: number;
    jobs: Map<string, RecentWorkflowsData>;
    workflows: Map<string, RecentWorkflowsData>
}

export default async function handler(
    req: NextApiRequest,
    res: NextApiResponse<void>
) {
    const authorization = req.headers.authorization;
    if (authorization === process.env.DRCI_BOT_KEY) {
        const { prNumber } = req.query;
        const octokit = await getOctokit(OWNER, REPO);
        updateDrciComments(octokit, prNumber as string);
        res.status(200).end();
    }
    res.status(403).end();
}

export async function updateDrciComments(octokit: Octokit, prNumber?: string) {
    const recentWorkflows: RecentWorkflowsData[] = await fetchRecentWorkflows(
        prNumber,
        NUM_MINUTES + ""
    );

    const workflowsByPR = reorganizeWorkflows(recentWorkflows);
    const sevs = getActiveSEVs(await fetchIssuesByLabel("ci: sev"));

    for (const [pr_number, pr_info] of workflowsByPR) {
        const { pending, failedJobs } = getWorkflowJobsStatuses(pr_info);

        const failureInfo = constructResultsComment(pending, failedJobs, pr_info.sha);
        const comment = formDrciComment(pr_number, failureInfo, formDrciSevBody(sevs));

        await updateCommentWithWorkflow(octokit, pr_info, comment);
    }
}

export function constructResultsComment(
    pending: number,
    failedJobs: RecentWorkflowsData[],
    sha: string
): string {
    let output = `\n`;
    const failing = failedJobs.length;
    const headerPrefix = `## `
    const pendingIcon = `:hourglass_flowing_sand:`
    const successIcon = `:white_check_mark:`
    const noneFailing = ` No Failures`;
    const someFailing = `## :x: ${failing} Failures`;
    const somePending = `, ${pending} Pending`;

    const hasFailing = failing > 0;
    const hasPending = pending > 0;
    if (!hasFailing) {
        output += headerPrefix
        if (hasPending) {
            output += pendingIcon
        } else {
            output += successIcon
        }

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
        const failedJobsSorted = failedJobs.sort((a, b) => a.name.localeCompare(b.name))
        for (const job of failedJobsSorted) {
            output += `* [${job.name}](${job.html_url})\n`;
        }
        output += "</p></details>"
    }
    return output;
}

export function getWorkflowJobsStatuses(prInfo: PRandJobs): {
  pending: number;
  failedJobs: RecentWorkflowsData[];
} {
  let numPending = 0;
  const failedJobsInfo: RecentWorkflowsData[] = [];
  for (const [_, job] of prInfo.jobs) {
    if (job.conclusion === null && job.completed_at === null) {
      numPending++;
    } else if (job.conclusion === "failure") {
      failedJobsInfo.push(job);
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
    if (!workflowsByPR.has(pr_number)) {
      workflowsByPR.set(pr_number, {
        pr_number: pr_number,
        sha: workflow.sha,
        jobs: new Map(),
        workflows: new Map(),
      });
    }
    const name = workflow.name!;
    const existing_job = workflowsByPR.get(pr_number).jobs.get(name);
    if (!existing_job || existing_job.id < workflow.id!) {
      // if rerun, choose the job with the larger id as that is more recent
      workflowsByPR.get(pr_number).jobs.set(name, workflow);
    }
  }
  return workflowsByPR;
}

export async function updateCommentWithWorkflow(
    octokit: Octokit,
    pr_info: PRandJobs,
    comment: string,
): Promise<void> {
    const { pr_number } = pr_info;
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
