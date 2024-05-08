import type { NextApiRequest, NextApiResponse } from "next";
import { getOctokit } from "lib/github";
import {
  fetchRecentWorkflows,
  fetchFailedJobsFromCommits,
} from "lib/fetchRecentWorkflows";
import { RecentWorkflowsData, IssueData, PRandJobs } from "lib/types";
import {
  NUM_MINUTES,
  formDrciComment,
  OWNER,
  getDrciComment,
  getActiveSEVs,
  formDrciSevBody,
  FLAKY_RULES_JSON,
  HUD_URL,
  hasSimilarFailures,
  isInfraFlakyJob,
  isLogClassifierFailed,
  fetchIssueLabels,
  getSuppressedLabels,
  isExcludedFromFlakiness,
} from "lib/drciUtils";
import fetchIssuesByLabel from "lib/fetchIssuesByLabel";
import { Octokit } from "octokit";
import { fetchJSON } from "lib/bot/utils";
import {
  removeJobNameSuffix,
  isSameFailure,
  removeCancelledJobAfterRetry,
  backfillMissingLog,
  isUnstableJob,
  getOpenUnstableIssues,
  getDisabledTestIssues,
  isRecentlyCloseDisabledTest,
  isDisabledTest,
  isDisabledTestMentionedInPR,
} from "lib/jobUtils";
import getRocksetClient from "lib/rockset";
import _ from "lodash";
import { fetchCommitTimestamp } from "lib/fetchCommit";
import fetchPR from "lib/fetchPR";

export interface FlakyRule {
  name: string;
  captures: string[];
}

export interface UpdateCommentBody {
  repo: string;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<{
    [pr: number]: { [cat: string]: RecentWorkflowsData[] };
  }>
) {
  const authorization = req.headers.authorization;

  if (authorization === process.env.DRCI_BOT_KEY) {
    const { prNumber } = req.query;
    const { repo }: UpdateCommentBody = req.body;
    const octokit = await getOctokit(OWNER, repo);

    const failures = await updateDrciComments(
      octokit,
      repo,
      prNumber as string
    );
    res.status(200).json(failures);
  }

  res.status(403).end();
}

export async function updateDrciComments(
  octokit: Octokit,
  repo: string = "pytorch",
  prNumber?: string
): Promise<{ [pr: number]: { [cat: string]: RecentWorkflowsData[] } }> {
  const recentWorkflows: RecentWorkflowsData[] = await fetchRecentWorkflows(
    `${OWNER}/${repo}`,
    prNumber,
    NUM_MINUTES + ""
  );

  const workflowsByPR = await reorganizeWorkflows(
    OWNER,
    repo,
    recentWorkflows,
    octokit
  );
  const head = get_head_branch(repo);
  await addMergeBaseCommits(octokit, repo, head, workflowsByPR);
  const sevs = getActiveSEVs(await fetchIssuesByLabel("ci: sev"));
  const flakyRules: FlakyRule[] = (await fetchJSON(FLAKY_RULES_JSON)) || [];
  const unstableIssues: IssueData[] = await fetchIssuesByLabel("unstable");
  const disabledTestIssues: IssueData[] = await fetchIssuesByLabel("skipped");
  const baseCommitJobs = await getBaseCommitJobs(workflowsByPR);
  const existingDrCiComments = await getExistingDrCiComments(
    `${OWNER}/${repo}`,
    workflowsByPR
  );

  // Return the list of all failed jobs grouped by their classification
  const failures: { [pr: number]: { [cat: string]: RecentWorkflowsData[] } } =
    {};

  await forAllPRs(
    workflowsByPR,
    async (pr_info: PRandJobs) => {
      const labels = await fetchIssueLabels(
        octokit,
        pr_info.owner,
        pr_info.repo,
        pr_info.pr_number
      );

      const {
        pending,
        failedJobs,
        flakyJobs,
        brokenTrunkJobs,
        unstableJobs,
        relatedJobs,
        relatedIssues,
        relatedInfo,
      } = await getWorkflowJobsStatuses(
        pr_info,
        flakyRules,
        baseCommitJobs.get(pr_info.merge_base) || new Map(),
        labels || [],
        unstableIssues || [],
        disabledTestIssues || []
      );

      failures[pr_info.pr_number] = {
        FAILED: failedJobs,
        FLAKY: flakyJobs,
        BROKEN_TRUNK: brokenTrunkJobs,
        UNSTABLE: unstableJobs,
      };

      const failureInfo = constructResultsComment(
        pending,
        failedJobs,
        flakyJobs,
        brokenTrunkJobs,
        unstableJobs,
        relatedJobs,
        relatedIssues,
        relatedInfo,
        pr_info.head_sha,
        pr_info.merge_base,
        pr_info.merge_base_date,
        HUD_URL,
        OWNER,
        repo,
        pr_info.pr_number
      );

      const comment = formDrciComment(
        pr_info.pr_number,
        OWNER,
        repo,
        failureInfo,
        formDrciSevBody(sevs)
      );

      const { id, body } =
        existingDrCiComments.get(pr_info.pr_number) ||
        (await getDrciComment(octokit, OWNER, repo, pr_info.pr_number));

      // The comment is there and remains unchanged, so there is no need to do anything
      if (body === comment) {
        return;
      }

      // If the id is 0, it means that the bot has failed to create the comment, so we
      // are free to create a new one here
      if (id === 0) {
        await octokit.rest.issues.createComment({
          body: comment,
          owner: OWNER,
          repo: repo,
          issue_number: pr_info.pr_number,
        });
      }
      // Otherwise, update the existing comment
      else {
        await octokit.rest.issues.updateComment({
          body: comment,
          owner: OWNER,
          repo: repo,
          comment_id: id,
        });
      }

      // Also update the check run status. As this is run under pytorch-bot,
      // the check run will show up under that GitHub app
      await octokit.rest.checks.create({
        owner: OWNER,
        repo: repo,
        name: "Dr.CI",
        head_sha: pr_info.head_sha,
        status: "completed",
        conclusion: "neutral",
        output: {
          title: "Dr.CI classification results",
          // NB: the summary contains the classification result from Dr.CI,
          // so that it can be queried elsewhere
          summary: JSON.stringify(failures[pr_info.pr_number]),
        },
      });
    },
    async (pr_info: PRandJobs, e: Error) => {
      console.log("Failed to update PR", pr_info.pr_number, e);
    }
  );

  return failures;
}

async function forAllPRs(
  workflowsByPR: Map<number, PRandJobs>,
  func: CallableFunction,
  errorFunc: CallableFunction
) {
  await Promise.all(
    Array.from(workflowsByPR.values()).map(async (pr_info) => {
      try {
        await func(pr_info);
      } catch (e) {
        await errorFunc(pr_info, e);
      }
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
  const mergeBasesQuery = `
select
    sha as head_sha,
    merge_base,
    merge_base_commit_date,
from
    merge_bases
where
    ARRAY_CONTAINS(SPLIT(:shas, ','), sha)
    and merge_base_commit_date is not null
    and repo = :repo
  `;
  const rocksetClient = getRocksetClient();

  const rocksetMergeBases = new Map(
    (
      await rocksetClient.queries.query({
        sql: {
          query: mergeBasesQuery,
          parameters: [
            {
              name: "shas",
              type: "string",
              value: Array.from(workflowsByPR.values())
                .map((v) => v.head_sha)
                .join(","),
            },
            {
              name: "repo",
              type: "string",
              value: `${OWNER}/${repo}`,
            },
          ],
        },
      })
    ).results?.map((v) => [v.head_sha, v])
  );
  const newData: any[] = [];

  await forAllPRs(
    workflowsByPR,
    async (pr_info: PRandJobs) => {
      const rocksetMergeBase = rocksetMergeBases.get(pr_info.head_sha);
      if (rocksetMergeBase === undefined) {
        // Not found in rockset, ask github instead, then put into rockset
        const diff = await octokit.rest.repos.compareCommits({
          owner: OWNER,
          repo: repo,
          base: pr_info.head_sha,
          head: head,
        });
        pr_info.merge_base = diff.data.merge_base_commit.sha;
        pr_info.merge_base_date =
          diff.data.merge_base_commit.commit.committer?.date ?? "";

        newData.push({
          sha: pr_info.head_sha,
          merge_base: pr_info.merge_base,
          changed_files: diff.data.files?.map((e) => e.filename),
          merge_base_commit_date: pr_info.merge_base_date ?? "",
          repo: `${OWNER}/${repo}`,
        });
      } else {
        pr_info.merge_base = rocksetMergeBase.merge_base;
        pr_info.merge_base_date = rocksetMergeBase.merge_base_commit_date;
      }
    },
    // NB (huydhn): This function couldn't find merge base for ghstack PR and
    // always throw an error in that case, so I decide to not print anything
    // here to void confusion when seeing this error in the log
    async (pr_info: PRandJobs, e: Error) => {
      // Insert dummy values if merge base can't be found
      pr_info.merge_base =
        "failed to retrieve merge base, please contact dev infra";
      // NB: Leave the merge base date empty or undefined here, any mock value
      // like 0 is treated as a timestamp to use when quering similar failures
      pr_info.merge_base_date = "";
    }
  );
  rocksetClient.documents.addDocuments("commons", "merge_bases", {
    data: newData,
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

async function getExistingDrCiComments(
  repoFullName: string,
  workflowsByPR: Map<number, PRandJobs>
) {
  const existingCommentsQuery = `
select
  id,
  body,
  issue_url,
from
  commons.issue_comment i
where
  i.body like '%<!-- drci-comment-start -->%'
  and ARRAY_CONTAINS(SPLIT(:prUrls, ','), issue_url)
    `;
  const rocksetClient = getRocksetClient();
  return new Map(
    (
      await rocksetClient.queries.query({
        sql: {
          query: existingCommentsQuery,
          parameters: [
            {
              name: "prUrls",
              type: "string",
              value: Array.from(workflowsByPR.keys())
                .map(
                  (prNumber) =>
                    `https://api.github.com/repos/${repoFullName}/issues/${prNumber}`
                )
                .join(","),
            },
          ],
        },
      })
    ).results?.map((v) => [
      parseInt(v.issue_url.split("/").pop()),
      { id: parseInt(v.id), body: v.body },
    ])
  );
}

function constructResultsJobsSections(
  hudBaseUrl: string,
  owner: string,
  repo: string,
  prNumber: number,
  header: string,
  description: string,
  jobs: RecentWorkflowsData[],
  suggestion?: string,
  collapsed: boolean = false,
  relatedJobs: Map<string, RecentWorkflowsData> = new Map(),
  relatedIssues: Map<string, IssueData[]> = new Map(),
  relatedInfo: Map<string, string> = new Map()
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

  const hudPrUrl = `${hudBaseUrl}/pr/${owner}/${repo}/${prNumber}`;
  const jobsSorted = jobs.sort((a, b) => a.name!.localeCompare(b.name!));
  for (const job of jobsSorted) {
    output += `* [${job.name}](${hudPrUrl}#${job.id}) ([gh](${job.html_url}))`;

    const relatedJob = relatedJobs.get(job.id);
    // Show the related trunk failure for broken trunk or the similar failure for flaky
    if (relatedJob !== undefined) {
      const hudCommitUrl = `${hudBaseUrl}/${owner}/${repo}/commit/${relatedJob.head_sha}`;
      const relatedJobUrl = `${hudCommitUrl}#${relatedJob.id}`;
      if (header === "BROKEN TRUNK") {
        output += ` ([trunk failure](${relatedJobUrl}))`;
      } else if (header === "FLAKY") {
        output += ` ([similar failure](${relatedJobUrl}))`;
      } else {
        output += ` ([related job](${relatedJobUrl}))`;
      }
    }

    const relatedIssue = relatedIssues.get(job.id);
    // Show all the related issues
    if (relatedIssue !== undefined) {
      const issueInfo = relatedIssue
        .map((issue) => `[#${issue.number}](${issue.html_url})`)
        .join(", ");
      output += ` (${issueInfo})`;
    }

    const info = relatedInfo.get(job.id);
    // Show all the related information
    if (info !== undefined) {
      output += ` (${info})`;
    }

    output += "\n";
    if (job.failure_captures) {
      output += `    \`${job.failure_captures[0]}\`\n`;
    }
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
  relatedJobs: Map<string, RecentWorkflowsData>,
  relatedIssues: Map<string, IssueData[]>,
  relatedInfo: Map<string, string>,
  sha: string,
  merge_base: string,
  merge_base_date: string,
  hudBaseUrl: string,
  owner: string,
  repo: string,
  prNumber: number
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
    let unrelatedFailuresMsg = unrelatedFailures;
    if (title_messages.length == 0) {
      // If there are no other messages, reassure the user that things are looking good
      unrelatedFailuresMsg =
        "You can merge normally! (" + unrelatedFailures + ")";
    }

    title_messages.push(unrelatedFailuresMsg);
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
    hudBaseUrl,
    owner,
    repo,
    prNumber,
    `NEW ${pluralize("FAILURE", failedJobs.length).toLocaleUpperCase()}`,
    `The following ${failedJobs.length > 1 ? "jobs have" : "job has"} failed`,
    failedJobs,
    "",
    false,
    relatedJobs,
    relatedIssues,
    relatedInfo
  );
  output += constructResultsJobsSections(
    hudBaseUrl,
    owner,
    repo,
    prNumber,
    "FLAKY",
    `The following ${pluralize("job", flakyJobs.length)} failed but ${pluralize(
      "was",
      flakyJobs.length,
      "were"
    )} likely due to flakiness present on trunk`,
    flakyJobs,
    "",
    true,
    relatedJobs,
    relatedIssues,
    relatedInfo
  );
  output += constructResultsJobsSections(
    hudBaseUrl,
    owner,
    repo,
    prNumber,
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
    true,
    relatedJobs,
    relatedIssues,
    relatedInfo
  );
  output += constructResultsJobsSections(
    hudBaseUrl,
    owner,
    repo,
    prNumber,
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
    true,
    relatedJobs,
    relatedIssues,
    relatedInfo
  );
  return output;
}

function isFlaky(
  job: RecentWorkflowsData,
  flakyRules: FlakyRule[]
): FlakyRule | undefined {
  return flakyRules.find((flakyRule) => {
    const jobNameRegex = new RegExp(flakyRule.name);

    return (
      job.name!.match(jobNameRegex) &&
      flakyRule.captures.every((capture: string) => {
        const captureRegex = new RegExp(capture);
        const matchFailureCaptures: boolean =
          job.failure_captures &&
          job.failure_captures.some((failureCapture) =>
            failureCapture.match(captureRegex)
          );
        const matchFailureLine: boolean =
          job.failure_lines != null &&
          job.failure_lines[0] != null &&
          job.failure_lines[0].match(captureRegex) != null;

        // Accept both failure captures array and failure line string to make sure
        // that nothing is missing
        return matchFailureCaptures || matchFailureLine;
      })
    );
  });
}

function getTrunkFailure(
  job: RecentWorkflowsData,
  baseJobs: Map<string, RecentWorkflowsData[]>
): RecentWorkflowsData | undefined {
  const jobNameNoSuffix = removeJobNameSuffix(job.name!);

  // This job doesn't exist in the base commit, thus not a broken trunk failure
  if (!baseJobs.has(jobNameNoSuffix)) {
    return;
  }

  return baseJobs
    .get(jobNameNoSuffix)!
    .find((baseJob) => isSameFailure(baseJob, job));
}

export async function getWorkflowJobsStatuses(
  prInfo: PRandJobs,
  flakyRules: FlakyRule[],
  baseJobs: Map<string, RecentWorkflowsData[]>,
  labels: string[] = [],
  unstableIssues: IssueData[] = [],
  disabledTestIssues: IssueData[] = []
): Promise<{
  pending: number;
  failedJobs: RecentWorkflowsData[];
  flakyJobs: RecentWorkflowsData[];
  brokenTrunkJobs: RecentWorkflowsData[];
  unstableJobs: RecentWorkflowsData[];
  relatedJobs: Map<string, RecentWorkflowsData>;
  relatedIssues: Map<string, IssueData[]>;
  relatedInfo: Map<string, string>;
}> {
  let pending = 0;
  const failedJobs: RecentWorkflowsData[] = [];
  const flakyJobs: RecentWorkflowsData[] = [];
  const brokenTrunkJobs: RecentWorkflowsData[] = [];
  const unstableJobs: RecentWorkflowsData[] = [];

  // This map holds the list of the base failures for broken trunk jobs or the similar
  // failures for flaky jobs
  const relatedJobs: Map<string, RecentWorkflowsData> = new Map();
  // And this holds the string pointing to the associated unstable issue that disables a job
  const relatedIssues: Map<string, IssueData[]> = new Map();
  // Any additional information about the job classification can be kept here
  const relatedInfo: Map<string, string> = new Map();

  for (const job of prInfo.jobs) {
    if (
      (job.conclusion === undefined || job.conclusion === null) &&
      (job.completed_at === undefined || job.completed_at === null)
    ) {
      pending++;
    } else if (job.conclusion === "failure" || job.conclusion === "cancelled") {
      const suppressedLabels = await getSuppressedLabels(job, labels);
      if (
        prInfo.repo === "pytorch" &&
        suppressedLabels &&
        suppressedLabels.length !== 0
      ) {
        flakyJobs.push(job);
        relatedInfo.set(job.id, `suppressed by ${suppressedLabels.join(", ")}`);
        continue;
      }

      if (isUnstableJob(job, unstableIssues)) {
        unstableJobs.push(job);
        relatedIssues.set(
          job.id,
          getOpenUnstableIssues(job.name, unstableIssues)
        );
        continue;
      }

      const trunkFailure = getTrunkFailure(job, baseJobs);
      if (trunkFailure !== undefined) {
        brokenTrunkJobs.push(job);
        relatedJobs.set(job.id, trunkFailure);
        continue;
      }

      const flakyRule = isFlaky(job, flakyRules);
      if (flakyRule !== undefined) {
        flakyJobs.push(job);
        relatedInfo.set(
          job.id,
          `matched **${flakyRule.name}** rule in [flaky-rules.json](https://github.com/pytorch/test-infra/blob/generated-stats/stats/flaky-rules.json)`
        );
        continue;
      }

      if (isInfraFlakyJob(job)) {
        flakyJobs.push(job);
        relatedInfo.set(job.id, `detected as infra flaky with no runner`);
        continue;
      }

      if ((await isLogClassifierFailed(job)) && !isExcludedFromFlakiness(job)) {
        flakyJobs.push(job);
        relatedInfo.set(
          job.id,
          `detected as infra flaky with no log or failing log classifier`
        );
        await backfillMissingLog(prInfo.owner, prInfo.repo, job);
        continue;
      }

      const matchDisabledTestIssues = getDisabledTestIssues(
        job,
        disabledTestIssues
      );
      if (
        matchDisabledTestIssues !== undefined &&
        matchDisabledTestIssues.length !== 0 &&
        isRecentlyCloseDisabledTest(
          matchDisabledTestIssues,
          prInfo.merge_base_date
        )
      ) {
        flakyJobs.push(job);
        const disabledTestIssuesMsg = matchDisabledTestIssues
          .map((issue) => `[#${issue.number}](${issue.html_url})`)
          .join(", ");
        relatedInfo.set(
          job.id,
          `disabled by ${disabledTestIssuesMsg} but the issue was closed recently and a rebase is needed to make it pass`
        );
        continue;
      }

      if (prInfo.repo === "pytorch") {
        // NB: Searching for similar failures depends on the accuracy of the log
        // classifier, so we only enable this in PyTorch core atm where the log
        // classifier works decently well
        const similarFailure = await hasSimilarFailures(
          job,
          prInfo.merge_base_date
        );
        if (similarFailure !== undefined) {
          flakyJobs.push(job);
          relatedJobs.set(job.id, similarFailure);
          continue;
        }
      }

      if (
        matchDisabledTestIssues !== undefined &&
        matchDisabledTestIssues.length !== 0 &&
        isDisabledTest(matchDisabledTestIssues)
      ) {
        if (isDisabledTestMentionedInPR(matchDisabledTestIssues, prInfo)) {
          // If the test is disabled and it's mentioned in the PR, its failure
          // would be legit, for example, the PR is trying to fix the flaky test
          relatedIssues.set(job.id, matchDisabledTestIssues);
        } else {
          // If the test is disabled and it's NOT mentioned anywhere in the PR,
          // its failure is consider flaky
          flakyJobs.push(job);
          const disabledTestIssuesMsg = matchDisabledTestIssues
            .map((issue) => `[#${issue.number}](${issue.html_url})`)
            .join(", ");
          relatedInfo.set(job.id, `disabled by ${disabledTestIssuesMsg}`);
          continue;
        }
      }

      failedJobs.push(job);
    }
  }

  return {
    pending,
    failedJobs,
    flakyJobs,
    brokenTrunkJobs,
    unstableJobs,
    relatedJobs,
    relatedIssues,
    relatedInfo,
  };
}

export async function reorganizeWorkflows(
  owner: string,
  repo: string,
  recentWorkflows: RecentWorkflowsData[],
  octokit?: Octokit
): Promise<Map<number, PRandJobs>> {
  const workflowsByPR: Map<number, PRandJobs> = new Map();
  const headShaTimestamps: Map<string, string> = new Map();

  for (const workflow of recentWorkflows) {
    const prNumber = workflow.pr_number!;
    if (!workflowsByPR.has(prNumber)) {
      let headShaTimestamp = workflow.head_sha_timestamp;
      // NB: The head SHA timestamp is currently used as the end date when searching
      // for similar failures.  However, it's not available on Rockset for commits
      // from forked PRs before a ciflow ref is pushed.  In such case, the head SHA
      // timestamp will be undefined and we will make an additional query to GitHub
      // to get the value
      if (octokit && !headShaTimestamp) {
        headShaTimestamp = await fetchCommitTimestamp(
          octokit,
          owner,
          repo,
          workflow.head_sha
        );
        headShaTimestamps.set(workflow.head_sha, headShaTimestamp);
      }

      let prTitle = "";
      let prBody = "";
      let prShas: { sha: string; title: string }[] = [];
      if (octokit) {
        const prData = await fetchPR(owner, repo, `${prNumber}`, octokit);
        prTitle = prData.title;
        prBody = prData.body;
        prShas = prData.shas;
      }

      workflowsByPR.set(prNumber, {
        pr_number: prNumber,
        head_sha: workflow.head_sha,
        head_sha_timestamp: headShaTimestamp,
        jobs: [],
        merge_base: "",
        merge_base_date: "",
        owner: owner,
        repo: repo,
        title: prTitle,
        body: prBody,
        shas: prShas,
      });
    }

    const headShaTimestamp = headShaTimestamps.get(workflow.head_sha);
    if (!workflow.head_sha_timestamp && headShaTimestamp) {
      workflow.head_sha_timestamp = headShaTimestamp;
    }

    workflowsByPR.get(prNumber)!.jobs.push(workflow);
  }

  // clean up the workflows - remove retries, remove workflows that have jobs,
  // remove cancelled jobs with weird names
  for (const [, prInfo] of workflowsByPR) {
    const [workflows, jobs] = _.partition(
      prInfo.jobs,
      (job) => job.workflowId === null || job.workflowId === undefined
    );

    // Get most recent workflow run based on workflowUniqueId (workflow_id in rockset)
    const recentWorkflows: Map<number, RecentWorkflowsData> = new Map();
    for (const workflow of workflows) {
      // Check that this is a workflow, not a job
      const workflowUniqueId = workflow.workflowUniqueId!;
      const existingWorkflowId = recentWorkflows.get(workflowUniqueId)?.id;
      if (!existingWorkflowId || existingWorkflowId! < workflow.id!) {
        recentWorkflows.set(workflowUniqueId, workflow);
      }
    }

    // Remove retries
    const removeRetries = new Map();
    for (const job of jobs) {
      if (
        job.workflowUniqueId &&
        recentWorkflows.get(job.workflowUniqueId) &&
        job.workflowId !== recentWorkflows.get(job.workflowUniqueId)!.id
      ) {
        // This belongs to an older run of the workflow
        continue;
      }
      const key = job.name!;
      const existing_job = removeRetries.get(key);
      if (!existing_job || existing_job.id < job.id!) {
        removeRetries.set(key, job);
      }
    }

    const workflowIdsWithJobs = new Set(
      Array.from(removeRetries.values()).map((job) => job.workflowId)
    );

    // Keep only workflows with no jobs
    const goodWorkflows = Array.from(recentWorkflows.values()).filter(
      (workflow: RecentWorkflowsData) => !workflowIdsWithJobs.has(workflow.id)
    );

    const allJobs = Array.from(removeRetries.values()).concat(goodWorkflows);
    // Remove cancelled jobs with weird names
    prInfo.jobs = removeCancelledJobAfterRetry<RecentWorkflowsData>(allJobs);
  }
  return workflowsByPR;
}
