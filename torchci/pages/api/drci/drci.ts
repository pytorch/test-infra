import type { NextApiRequest, NextApiResponse } from "next";
import { getOctokit } from "lib/github";
import {
  fetchRecentWorkflows,
  fetchFailedJobsFromCommits,
} from "lib/fetchRecentWorkflows";
import { RecentWorkflowsData } from "lib/types";
import {
  NUM_MINUTES,
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
import { removeJobNameSuffix } from "lib/jobUtils";

interface PRandJobs {
  head_sha: string;
  pr_number: number;
  jobs: Map<string, RecentWorkflowsData>;
  merge_base: string;
  merge_base_date: string;
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

export async function updateDrciComments(
  octokit: Octokit,
  repo: string = "pytorch",
  prNumber?: string
) {
  const recentWorkflows: RecentWorkflowsData[] = await fetchRecentWorkflows(
    `${OWNER}/${repo}`,
    prNumber,
    NUM_MINUTES + ""
  );

  const workflowsByPR = reorganizeWorkflows(recentWorkflows);
  const head = get_head_branch(repo);
  await addMergeBaseCommits(octokit, repo, head, workflowsByPR);
  const sevs = getActiveSEVs(await fetchIssuesByLabel("ci: sev"));
  const flakyRules: FlakyRule[] = (await fetchJSON(FLAKY_RULES_JSON)) || [];
  const baseCommitJobs = await getBaseCommitJobs(workflowsByPR);

  await forAllPRs(workflowsByPR, async (pr_info: PRandJobs) => {
    const { pending, failedJobs, flakyJobs, brokenTrunkJobs, unstableJobs } =
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
      unstableJobs,
      pr_info.head_sha,
      pr_info.merge_base,
      pr_info.merge_base_date,
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

async function forAllPRs(
  workflowsByPR: Map<number, PRandJobs>,
  func: CallableFunction
) {
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
    pr_info.merge_base_date =
      diff.data.merge_base_commit.commit.committer?.date ?? "";
  });
}

export async function getBaseCommitJobs(
  workflowsByPR: Map<number, PRandJobs>
): Promise<Map<string, Map<string, RecentWorkflowsData[]>>> {
  // get merge base shas
  let baseShas = [];
  for (const [_, pr_info] of workflowsByPR) {
    baseShas.push(pr_info.merge_base);
  }

  // fetch failing jobs on those shas
  const commitFailedJobsQueryResult = await fetchFailedJobsFromCommits(
    baseShas
  );

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

  const jobsByShaByName = new Map();
  // regroup the list of failed jobs one more time to remove the shard ID and
  // the unstable suffix. The former is not needed because the tests could be
  // run by another shard and failed the same way. The unstable suffix is also
  // not needed because it's there only to decorate the job name.
  for (const sha of jobsBySha.keys()) {
    if (!jobsByShaByName.has(sha)) {
      jobsByShaByName.set(sha, new Map());
    }

    for (const jobName of jobsBySha.get(sha).keys()) {
      const jobNameNoSuffix = removeJobNameSuffix(jobName);
      const job = jobsBySha.get(sha).get(jobName);

      if (!jobsByShaByName.get(sha).has(jobNameNoSuffix)) {
        jobsByShaByName.get(sha).set(jobNameNoSuffix, []);
      }

      jobsByShaByName.get(sha).get(jobNameNoSuffix).push(job);
    }
  }

  return jobsByShaByName;
}

function constructResultsJobsSections(
  hud_pr_url: string,
  header: string,
  description: string,
  jobs: RecentWorkflowsData[],
  suggestion?: string,
  collapsed: boolean = false
): string {
  if (jobs.length === 0) {
    return "";
  }
  let output = `\n<details ${
    collapsed ? "" : "open"
  }><summary><b>${header}</b> - ${description}:</summary>`;

  if (suggestion) {
    output += `<p>👉 <b>${suggestion}</b></p>`;
  }

  output += "<p>\n\n"; // Two newlines are needed for bullts below to be formattec correctly
  const jobsSorted = jobs.sort((a, b) => a.name.localeCompare(b.name));
  for (const job of jobsSorted) {
    output += `* [${job.name}](${hud_pr_url}#${job.id}) ([gh](${job.html_url}))\n`;
  }
  output += "</p></details>";
  return output;
}

function pluralize(word: string, count: number, pluralForm?: string): string {
  if (count === 1) {
    return word;
  }

  if (pluralForm) {
    return pluralForm;
  }

  return `${word}s`;
}

export function constructResultsComment(
  pending: number,
  failedJobs: RecentWorkflowsData[],
  flakyJobs: RecentWorkflowsData[],
  brokenTrunkJobs: RecentWorkflowsData[],
  unstableJobs: RecentWorkflowsData[],
  sha: string,
  merge_base: string,
  merge_base_date: string,
  hud_pr_url: string
): string {
  let output = `\n`;
  const unrelatedFailureCount =
    flakyJobs.length + brokenTrunkJobs.length + unstableJobs.length;
  const failing =
    failedJobs.length +
    flakyJobs.length +
    brokenTrunkJobs.length +
    unstableJobs.length;
  const headerPrefix = `## `;
  const pendingIcon = `:hourglass_flowing_sand:`;
  const successIcon = `:white_check_mark:`;
  const failuresIcon = `:x:`;
  const noneFailing = `No Failures`;
  const significantFailures = `${failedJobs.length} New ${pluralize(
    "Failure",
    failedJobs.length
  )}`;
  const unrelatedFailures = `${unrelatedFailureCount} Unrelated ${pluralize(
    "Failure",
    unrelatedFailureCount
  )}`;
  const pendingJobs = `${pending} Pending`;

  const hasAnyFailing = failing > 0;
  const hasSignificantFailures = failedJobs.length > 0;
  const hasPending = pending > 0;
  const hasUnrelatedFailures =
    flakyJobs.length + brokenTrunkJobs.length + unstableJobs.length;

  let icon = "";
  if (hasSignificantFailures) {
    icon = failuresIcon;
  } else if (hasPending) {
    icon = pendingIcon;
  } else {
    icon = successIcon;
  }

  let title_messages = [];
  if (hasSignificantFailures) {
    title_messages.push(significantFailures);
  }
  if (!hasAnyFailing) {
    title_messages.push(noneFailing);
  }
  if (hasPending) {
    title_messages.push(pendingJobs);
  }
  if (hasUnrelatedFailures) {
    title_messages.push(unrelatedFailures);
  }

  let title = headerPrefix + icon + " " + title_messages.join(", ");
  output += title;

  output += `\nAs of commit ${sha} with merge base ${merge_base}`;
  const timestamp = Math.floor(new Date(merge_base_date).valueOf() / 1000);
  if (!isNaN(timestamp)) {
    output += ` (<sub><sub><img alt="image" width=70 src="https://img.shields.io/date/${timestamp}?label=&color=FFFFFF&style=flat-square"></sub></sub>)`;
  }
  output += ":";

  if (!hasAnyFailing) {
    output += `\n:green_heart: Looks good so far! There are no failures yet. :green_heart:`;
  }
  output += constructResultsJobsSections(
    hud_pr_url,
    `NEW ${pluralize("FAILURE", failedJobs.length).toLocaleUpperCase()}`,
    `The following ${failedJobs.length > 1 ? "jobs have" : "job has"} failed`,
    failedJobs
  );
  output += constructResultsJobsSections(
    hud_pr_url,
    "FLAKY",
    `The following ${pluralize("job", flakyJobs.length)} failed but ${pluralize(
      "was",
      flakyJobs.length,
      "were"
    )} likely due to flakiness present on trunk`,
    flakyJobs,
    "",
    true
  );
  output += constructResultsJobsSections(
    hud_pr_url,
    "BROKEN TRUNK",
    `The following ${pluralize(
      "job",
      brokenTrunkJobs.length
    )} failed but ${pluralize(
      "was",
      flakyJobs.length,
      "were"
    )} present on the merge base`,
    brokenTrunkJobs,
    "Rebase onto the `viable/strict` branch to avoid these failures",
    true
  );
  output += constructResultsJobsSections(
    hud_pr_url,
    "UNSTABLE",
    `The following ${pluralize(
      "job",
      unstableJobs.length
    )} failed but ${pluralize(
      "was",
      unstableJobs.length,
      "were"
    )} likely due to flakiness present on trunk and has been marked as unstable`,
    unstableJobs,
    "",
    true
  );
  return output;
}

function isFlaky(job: RecentWorkflowsData, flakyRules: FlakyRule[]): boolean {
  return flakyRules.some((flakyRule) => {
    const jobNameRegex = new RegExp(flakyRule.name);

    return (
      job.name.match(jobNameRegex) &&
      flakyRule.captures.every((capture: string) => {
        const captureRegex = new RegExp(capture);
        const matchFailureCaptures: boolean =
          job.failure_captures &&
          job.failure_captures.some((failureCapture) =>
            failureCapture.match(captureRegex)
          );
        const matchFailureLine: boolean =
          job.failure_line != null &&
          job.failure_line.match(captureRegex) != null;

        // Accept both failure captures array and failure line string to make sure
        // that nothing is missing
        return matchFailureCaptures || matchFailureLine;
      })
    );
  });
}

function isBrokenTrunk(
  job: RecentWorkflowsData,
  baseJobs: Map<string, RecentWorkflowsData[]>
): boolean {
  const jobNameNoSuffix = removeJobNameSuffix(job.name);

  // This job doesn't exist in the base commit, thus not a broken trunk failure
  if (!baseJobs.has(jobNameNoSuffix)) {
    return false;
  }

  return baseJobs.get(jobNameNoSuffix)!.some((baseJob) => {
    if (
      baseJob.conclusion == job.conclusion &&
      isEqual(baseJob.failure_captures, job.failure_captures)
    ) {
      return true;
    }

    return false;
  });
}

export function getWorkflowJobsStatuses(
  prInfo: PRandJobs,
  flakyRules: FlakyRule[],
  baseJobs: Map<string, RecentWorkflowsData[]>
): {
  pending: number;
  failedJobs: RecentWorkflowsData[];
  flakyJobs: RecentWorkflowsData[];
  brokenTrunkJobs: RecentWorkflowsData[];
  unstableJobs: RecentWorkflowsData[];
} {
  let pending = 0;
  const failedJobs: RecentWorkflowsData[] = [];
  const flakyJobs: RecentWorkflowsData[] = [];
  const brokenTrunkJobs: RecentWorkflowsData[] = [];
  const unstableJobs: RecentWorkflowsData[] = [];
  for (const [name, job] of prInfo.jobs) {
    if (job.conclusion === null && job.completed_at === null) {
      pending++;
    } else if (job.conclusion === "failure" || job.conclusion === "cancelled") {
      if (job.name !== undefined && job.name.includes("unstable")) {
        unstableJobs.push(job);
      } else if (isBrokenTrunk(job, baseJobs)) {
        brokenTrunkJobs.push(job);
      } else if (isFlaky(job, flakyRules)) {
        flakyJobs.push(job);
      } else {
        failedJobs.push(job);
      }
    }
  }
  return { pending, failedJobs, flakyJobs, brokenTrunkJobs, unstableJobs };
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
        merge_base_date: "",
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
  repo: string
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
