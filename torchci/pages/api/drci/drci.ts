import type { NextApiRequest, NextApiResponse } from "next";
import { getOctokit } from "lib/github";
import {
  fetchRecentWorkflows,
  fetchFailedJobsFromCommits,
} from "lib/fetchRecentWorkflows";
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
import urllib from "urllib";
import { isEqual } from "lodash";

interface PRandJobs {
    head_sha: string;
    pr_number: number;
    jobs: Map<string, RecentWorkflowsData>;
    merge_base: string;
}

export interface FlakyJob {
  name: string;
  captures: string[];
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
    await addMergeBaseCommits(octokit, workflowsByPR);
    const sevs = getActiveSEVs(await fetchIssuesByLabel("ci: sev"));
    const masterFlakyJobs = await getFlakyJobs();
    const baseCommitJobs = await getBaseCommitJobs(workflowsByPR);

    await Promise.all(
      Array.from(workflowsByPR.values()).map(async (pr_info) => {
        const { pending, failedJobs, flakyJobs, brokenTrunkJobs } =
          getWorkflowJobsStatuses(
            pr_info,
            masterFlakyJobs,
            baseCommitJobs.get(pr_info.merge_base) || new Map()
          );

        const failureInfo = constructResultsComment(
          pending,
          failedJobs,
          flakyJobs,
          brokenTrunkJobs,
          pr_info.head_sha,
          pr_info.merge_base
        );
        const comment = formDrciComment(
          pr_info.pr_number,
          failureInfo,
          formDrciSevBody(sevs)
        );

        await updateCommentWithWorkflow(octokit, pr_info, comment);
      })
    );
    console.log("done")
}

async function addMergeBaseCommits(
  octokit: Octokit,
  workflowsByPR: Map<number, PRandJobs>
) {
  await Promise.all(
    Array.from(workflowsByPR.values()).map(async (pr_info) => {
      const diff = await octokit.rest.repos.compareCommits({
        owner: OWNER,
        repo: REPO,
        base: pr_info.head_sha,
        head: "master",
      });
      pr_info.merge_base = diff.data.merge_base_commit.sha;
    })
  );
}

async function getBaseCommitJobs(
  workflowsByPR: Map<number, PRandJobs>
): Promise<Map<string, Map<string, RecentWorkflowsData>>> {
  // get merge base shas
  let baseShas = [];
  for (const [_, pr_info] of workflowsByPR) {
    baseShas.push(pr_info.merge_base);
  }

  // fetch failing jobs on those shas
  const commitFailedJobsQueryResult = await fetchFailedJobsFromCommits(baseShas);

  // reorganize into a map of sha -> name -> data
  const jobsBySha = new Map();
  for (const job of commitFailedJobsQueryResult) {
    if (!jobsBySha.has(job.head_sha)) {
      jobsBySha.set(job.head_sha, new Map());
    }
    const existing_job = jobsBySha.get(job.head_sha).get(job.name!);
    if (!existing_job || existing_job.id < job.id!) {
      // if rerun, choose the job with the larger id as that is more recent
      jobsBySha.get(job.head_sha).set(job.name, job);
    }
  }
  return jobsBySha;
}

async function getFlakyJobs(): Promise<FlakyJob[]> {
  const urlkey =
    "https://raw.githubusercontent.com/pytorch/test-infra/generated-stats/stats/rules.json";

  const result = await urllib.request(urlkey);
  if (result.res.statusCode !== 200) {
    return [];
  }
  const flakyJobs: FlakyJob[] = JSON.parse(result.data.toString());
  return flakyJobs;
}

function constructResultsJobsSections(
  header: string,
  jobs: RecentWorkflowsData[]
): string {
  if (jobs.length === 0) {
    return "";
  }
  let output = `\n<details open><summary>${header}:</summary>\n\n`;
  const jobsSorted = jobs.sort((a, b) => a.name.localeCompare(b.name));
  for (const job of jobsSorted) {
    output += `* [${job.name}](${job.html_url})\n`;
  }
  output += "</details>";
  return output;
}

export function constructResultsComment(
    pending: number,
    failedJobs: RecentWorkflowsData[],
    flakyJobs: RecentWorkflowsData[],
    brokenTrunkJobs: RecentWorkflowsData[],
    sha: string,
    merge_base: string,
): string {
    let output = `\n`;
    const failing = failedJobs.length + flakyJobs.length + brokenTrunkJobs.length;
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
        output += constructResultsJobsSections(
          "The following jobs have failed",
          failedJobs
        );
    }
    output += constructResultsJobsSections(
      "The following jobs failed but were likely due to flakiness present on master",
      flakyJobs
    );
    output += constructResultsJobsSections(
      `The following jobs failed but were likely due to broken trunk (merge base ${merge_base})`,
      brokenTrunkJobs
    );
    return output;
}

function isFlaky(
  job: RecentWorkflowsData,
  masterFlakyJobs: FlakyJob[]
): boolean {
  return masterFlakyJobs.some(
    (masterFlakyJob) =>
      job.name.includes(masterFlakyJob.name) &&
      masterFlakyJob.captures.every((capture) =>
        job.failure_captures.includes(capture)
      )
  );
}

export function getWorkflowJobsStatuses(
  prInfo: PRandJobs,
  masterFlakyJobs: FlakyJob[],
  baseJobs: Map<string, RecentWorkflowsData>
): {
  pending: number;
  failedJobs: RecentWorkflowsData[];
  flakyJobs: RecentWorkflowsData[];
  brokenTrunkJobs: RecentWorkflowsData[];
} {
  let pending = 0;
  const failedJobs: RecentWorkflowsData[] = [];
  const flakyJobs: RecentWorkflowsData[] = [];
  const brokenTrunkJobs: RecentWorkflowsData[] = [];
  for (const [name, job] of prInfo.jobs) {
    if (job.conclusion === null && job.completed_at === null) {
      pending++;
    } else if (job.conclusion === "failure" || job.conclusion === "cancelled") {
      if (
        baseJobs.get(job.name)?.conclusion == job.conclusion &&
        isEqual(job.failure_captures, baseJobs.get(job.name)?.failure_captures)
      ) {
        brokenTrunkJobs.push(job);
      } else if (isFlaky(job, masterFlakyJobs)) {
        flakyJobs.push(job);
      } else {
        failedJobs.push(job);
      }
    }
  }
  return { pending, failedJobs, flakyJobs, brokenTrunkJobs };
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
        head_sha: workflow.head_sha,
        jobs: new Map(),
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
