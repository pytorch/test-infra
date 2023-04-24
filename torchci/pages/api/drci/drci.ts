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
  FLAKY_RULES_JSON,
  HUD_URL,
} from "lib/drciUtils";
import fetchIssuesByLabel from "lib/fetchIssuesByLabel";
import { Octokit } from "octokit";
import { isEqual } from "lodash";
import { fetchJSON } from "lib/bot/utils";

interface PRandJobs {
    head_sha: string;
    pr_number: number;
    jobs: Map<string, RecentWorkflowsData>;
    merge_base: string;
}

export interface FlakyRule {
  name: string;
  captures: string[];
}

export interface UpdateCommentBody {
    repo: string;
}

export default async function handler(
    req: NextApiRequest,
    res: NextApiResponse<void>
) {
    const authorization = req.headers.authorization;

    if (authorization === process.env.DRCI_BOT_KEY) {
        const { prNumber } = req.query;
        const { repo }: UpdateCommentBody = req.body;
        const octokit = await getOctokit(OWNER, repo);
        updateDrciComments(octokit, repo, prNumber as string);

        res.status(200).end();
    }
    res.status(403).end();
}

export async function updateDrciComments(octokit: Octokit, repo: string = "pytorch", prNumber?: string) {
    const recentWorkflows: RecentWorkflowsData[] = await fetchRecentWorkflows(
        `${OWNER}/${repo}`,
        prNumber,
        NUM_MINUTES + ""
    );

    const workflowsByPR = reorganizeWorkflows(recentWorkflows);
    const head = get_head_branch(repo);
    await addMergeBaseCommits(octokit, repo, head, workflowsByPR);
    const sevs = getActiveSEVs(await fetchIssuesByLabel("ci: sev"));
    const flakyRules: FlakyRule[] = await fetchJSON(FLAKY_RULES_JSON) || [];
    const baseCommitJobs = await getBaseCommitJobs(workflowsByPR);

    await forAllPRs(workflowsByPR, async (pr_info: PRandJobs) => {
      const { pending, failedJobs, flakyJobs, brokenTrunkJobs } =
        getWorkflowJobsStatuses(
          pr_info,
          flakyRules,
          baseCommitJobs.get(pr_info.merge_base) || new Map()
        );

      const failureInfo = constructResultsComment(
        pending,
        failedJobs,
        flakyJobs,
        brokenTrunkJobs,
        pr_info.head_sha,
        pr_info.merge_base,
        `${HUD_URL}${OWNER}/${repo}/${pr_info.pr_number}`
      );

      const comment = formDrciComment(
        pr_info.pr_number,
        OWNER,
        repo,
        failureInfo,
        formDrciSevBody(sevs)
      );

      await updateCommentWithWorkflow(octokit, pr_info, comment, repo);
    });
}

async function forAllPRs(workflowsByPR: Map<number, PRandJobs>, func: CallableFunction) {
  await Promise.all(
    Array.from(workflowsByPR.values()).map(async (pr_info) => {
      await func(pr_info);
    })
  );
}

function get_head_branch(repo: string) {
    return "main";
}

async function addMergeBaseCommits(
  octokit: Octokit,
  repo: string,
  head: string,
  workflowsByPR: Map<number, PRandJobs>
) {
  await forAllPRs(workflowsByPR, async (pr_info: PRandJobs) => {
    const diff = await octokit.rest.repos.compareCommits({
      owner: OWNER,
      repo: repo,
      base: pr_info.head_sha,
      head: head,
    });

    pr_info.merge_base = diff.data.merge_base_commit.sha;
  });
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

function constructResultsJobsSections(
  hud_pr_url: string,
  header: string,
  description: string,
  jobs: RecentWorkflowsData[],
  suggestion?: string,
): string {
  if (jobs.length === 0) {
    return "";
  }
  let output = `\n<details open><summary><b>${header}</b> - ${description}:</summary>`;

  if (suggestion) {
    output += `<p>👉 <b>${suggestion}</b></p>`
  }

  output += "<p>\n\n" // Two newlines are needed for bullts below to be formattec correctly
  const jobsSorted = jobs.sort((a, b) => a.name.localeCompare(b.name));
  for (const job of jobsSorted) {
    output += `* [${job.name}](${hud_pr_url}#${job.id}) ([gh](${job.html_url}))\n`;
  }
  output += "</p></details>";
  return output;
}

export function constructResultsComment(
    pending: number,
    failedJobs: RecentWorkflowsData[],
    flakyJobs: RecentWorkflowsData[],
    brokenTrunkJobs: RecentWorkflowsData[],
    sha: string,
    merge_base: string,
    hud_pr_url: string,
): string {
    let output = `\n`;
    const failing = failedJobs.length + flakyJobs.length + brokenTrunkJobs.length;
    const headerPrefix = `## `
    const pendingIcon = `:hourglass_flowing_sand:`
    const successIcon = `:white_check_mark:`
    const failuresIcon = `:x:`
    const noneFailing = `No Failures`
    const significantFailures = `${failedJobs.length} Significant Failures`
    const unrelatedFailures = `${flakyJobs.length + brokenTrunkJobs.length} Unrelated Failures`
    const pendingJobs = `${pending} Pending`

    const hasAnyFailing = failing > 0
    const hasSignificantFailures = failedJobs.length > 0
    const hasPending = pending > 0
    const hasUnrelatedFailures = flakyJobs.length + brokenTrunkJobs.length
    
    let icon = ''
    if (hasSignificantFailures) {
      icon = failuresIcon
    } else if (hasPending) {
      icon = pendingIcon
    } else {
      icon = successIcon
    }

    let title_messages = []
    if (hasSignificantFailures) {
      title_messages.push(significantFailures)
    }
    if (!hasAnyFailing) {
      title_messages.push(noneFailing)
    }
    if (hasPending) {
      title_messages.push(pendingJobs)
    }
    if (hasUnrelatedFailures){
      title_messages.push(unrelatedFailures)
    }

    let title = headerPrefix + icon + ' ' + title_messages.join(', ')
    output += title
    output += `\nAs of commit ${sha}:`;


    if (!hasAnyFailing) {
      output += `\n:green_heart: Looks good so far! There are no failures yet. :green_heart:`;
    }
    output += constructResultsJobsSections(
      hud_pr_url,
      "NEW FAILURES",
      "The following jobs have failed",
      failedJobs,
    );
    output += constructResultsJobsSections(
      hud_pr_url,
      "FLAKY",
      "The following jobs failed but were likely due to flakiness present on trunk",
      flakyJobs
    );
    output += constructResultsJobsSections(
      hud_pr_url,
      "BROKEN TRUNK",
      `The following jobs failed but were present on the merge base ${merge_base}`,
      brokenTrunkJobs,
      "Rebase onto the `viable/strict` branch to avoid these failures"
    );
    return output;
}

function isFlaky(
  job: RecentWorkflowsData,
  masterFlakyJobs: FlakyRule[]
): boolean {
  return masterFlakyJobs.some(
    (masterFlakyJob) =>
      job.name.includes(masterFlakyJob.name) &&
      masterFlakyJob.captures.every((capture) =>
        job.failure_captures?.includes(capture)
      )
  );
}

export function getWorkflowJobsStatuses(
  prInfo: PRandJobs,
  flakyRules: FlakyRule[],
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
      } else if (isFlaky(job, flakyRules)) {
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
  const workflowsByPR: Map<number, PRandJobs> = new Map();

  for (const workflow of recentWorkflows) {
    const pr_number = workflow.pr_number!;
    if (!workflowsByPR.has(pr_number)) {
      workflowsByPR.set(pr_number, {
        pr_number: pr_number,
        head_sha: workflow.head_sha,
        jobs: new Map(),
        merge_base: "",
      });
    }
    const name = workflow.name!;
    const existing_job = workflowsByPR.get(pr_number)?.jobs.get(name);
    if (!existing_job || existing_job.id < workflow.id!) {
      // if rerun, choose the job with the larger id as that is more recent
      workflowsByPR.get(pr_number)!.jobs.set(name, workflow);
    }
  }

  // clean up the workflows - remove workflows that have jobs
  for (const [, prInfo] of workflowsByPR) {
    const workflowIds = Array.from(prInfo.jobs.values()).map(
      (jobInfo: RecentWorkflowsData) => jobInfo.workflow_id
    );
    const newJobs: Map<string, RecentWorkflowsData> = new Map();
    for (const [jobName, jobInfo] of prInfo.jobs) {
      if (!workflowIds.includes(jobInfo.id)) {
        newJobs.set(jobName, jobInfo);
      }
    }
    prInfo.jobs = newJobs;
  }
  return workflowsByPR;
}

export async function updateCommentWithWorkflow(
    octokit: Octokit,
    pr_info: PRandJobs,
    comment: string,
    repo: string,
): Promise<void> {
    const { pr_number } = pr_info;
    const { id, body } = await getDrciComment(octokit, OWNER, repo, pr_number!);

    if (id === 0 || body === comment) {
        return;
    }

    await octokit.rest.issues.updateComment({
        body: comment,
        owner: OWNER,
        repo: repo,
        comment_id: id,
    });
}
