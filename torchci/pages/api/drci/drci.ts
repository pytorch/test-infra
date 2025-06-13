import { PutObjectCommand } from "@aws-sdk/client-s3";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { fetchJSON, isTime0 } from "lib/bot/utils";
import { queryClickhouse } from "lib/clickhouse";
import {
  CANCELLED_STEP_ERROR,
  fetchPRLabels,
  FLAKY_RULES_JSON,
  formDrciComment,
  formDrciSevBody,
  getActiveSEVs,
  getDrciComment,
  getPRMergeCommits,
  getSuppressedLabels,
  hasSimilarFailures,
  hasSimilarFailuresInSamePR,
  HUD_URL,
  isExcludedFromBrokenTrunk,
  isExcludedFromFlakiness,
  isExcludedFromSimilarityPostProcessing,
  isInfraFlakyJob,
  isLogClassifierFailed,
  NUM_MINUTES,
  OWNER,
} from "lib/drciUtils";
import { fetchCommitTimestamp } from "lib/fetchCommit";
import fetchIssuesByLabel from "lib/fetchIssuesByLabel";
import fetchPR from "lib/fetchPR";
import {
  fetchFailedJobsFromCommits,
  fetchRecentWorkflows,
} from "lib/fetchRecentWorkflows";
import { getOctokit, getOctokitWithUserToken } from "lib/github";
import {
  backfillMissingLog,
  getDisabledTestIssues,
  getOpenUnstableIssues,
  isDisabledTest,
  isDisabledTestMentionedInPR,
  isRecentlyCloseDisabledTest,
  isSameFailure,
  isUnstableJob,
  removeCancelledJobAfterRetry,
  removeJobNameSuffix,
} from "lib/jobUtils";
import { drCIRateLimitExceeded, incrementDrCIRateLimit } from "lib/rateLimit";
import { getS3Client } from "lib/s3";
import { IssueData, PRandJobs, RecentWorkflowsData } from "lib/types";
import _ from "lodash";
import type { NextApiRequest, NextApiResponse } from "next";
import { Octokit } from "octokit";
dayjs.extend(utc);
export interface FlakyRule {
  name: string;
  captures: string[];
}

export interface UpdateCommentBody {
  repo: string;
}

// Attempt to set the maxDuration of this serveless function on Vercel https://vercel.com/docs/functions/configuring-functions/duration,
// also according to https://vercel.com/docs/functions/runtimes#max-duration, the max duration
// for an enterprise account is 900
export const config = {
  maxDuration: 900,
};

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<{
    [pr: number]: { [cat: string]: RecentWorkflowsData[] };
  }>
) {
  const authorization = req.headers.authorization;

  if (authorization == process.env.DRCI_BOT_KEY) {
    // Dr. CI bot key is used to update the comment, probably called from the
    // update Dr. CI workflow
  } else if (authorization) {
    // Authorization provided, probably a user calling it.
    // Check that they are only updating a single PR
    const { prNumber } = req.query;
    if (prNumber === undefined) {
      return res.status(403).end();
    }
    // Check if they exceed the rate limit
    const userOctokit = await getOctokitWithUserToken(authorization as string);
    const user = await userOctokit.rest.users.getAuthenticated();
    if (await drCIRateLimitExceeded(user.data.login)) {
      return res.status(429).end();
    }
    incrementDrCIRateLimit(user.data.login);
  } else {
    // No authorization provided, return 403
    return res.status(403).end();
  }

  const { prNumber } = req.query;
  const { repo }: UpdateCommentBody = req.body;
  const octokit = await getOctokit(OWNER, repo);

  const failures = await updateDrciComments(
    octokit,
    repo,
    prNumber ? [parseInt(prNumber as string)] : []
  );
  res.status(200).json(failures);
}

export async function updateDrciComments(
  octokit: Octokit,
  repo: string = "pytorch",
  prNumbers: number[]
): Promise<{ [pr: number]: { [cat: string]: RecentWorkflowsData[] } }> {
  // Fetch in two separate queries because combining into one query took much
  // longer to run on CH
  const [recentWorkflows, workflowsFromPendingComments] = await Promise.all([
    fetchRecentWorkflows(`${OWNER}/${repo}`, prNumbers, NUM_MINUTES + ""),
    // Only fetch if we are not updating a specific PR
    prNumbers.length != 0
      ? []
      : fetchRecentWorkflows(
          `${OWNER}/${repo}`,
          await getPRsWithPendingJobInComment(`${OWNER}/${repo}`),
          NUM_MINUTES + ""
        ),
  ]);

  const workflowsByPR = await reorganizeWorkflows(
    OWNER,
    repo,
    recentWorkflows.concat(workflowsFromPendingComments),
    octokit
  );
  const head = get_head_branch(repo);
  await addMergeBaseCommits(octokit, repo, head, workflowsByPR);
  const sevs = getActiveSEVs(
    await fetchIssuesByLabel("ci: sev", /*cache*/ true)
  );
  const flakyRules: FlakyRule[] = (await fetchJSON(FLAKY_RULES_JSON)) || [];
  const unstableIssues: IssueData[] = await fetchIssuesByLabel(
    "unstable",
    /*cache*/ true
  );
  const disabledTestIssues: IssueData[] = await fetchIssuesByLabel(
    "skipped",
    /*cache*/ true
  );
  const baseCommitJobs = await getBaseCommitJobs(workflowsByPR);
  const existingDrCiComments = await getExistingDrCiComments(
    `${OWNER}/${repo}`,
    workflowsByPR
  );
  const prMergeCommits = await getPRMergeCommits(
    OWNER,
    repo,
    Array.from(workflowsByPR.keys())
  );

  // Return the list of all failed jobs grouped by their classification
  const failures: { [pr: number]: { [cat: string]: RecentWorkflowsData[] } } =
    {};

  await forAllPRs(
    workflowsByPR,
    async (pr_info: PRandJobs) => {
      // Find the merge commits of the PR to check if it has already been merged before
      const mergeCommits = prMergeCommits.get(pr_info.pr_number) || [];

      const labels = await fetchPRLabels(
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
        disabledTestIssues || [],
        mergeCommits || []
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
          summary: JSON.stringify(
            removeFailureContext(failures[pr_info.pr_number])
          ),
        },
      });
    },
    async (pr_info: PRandJobs, e: Error) => {
      console.log("Failed to update PR", pr_info.pr_number, e);
    }
  );

  return failures;
}

/**
 * Changes the failure context of each job to an empty array. This is done to
 * reduce the size of the payload, which can some times exceed the maximum size
 * allowed by GitHub
 * @param failure
 * @returns
 */
function removeFailureContext(failure: {
  [cat: string]: RecentWorkflowsData[];
}) {
  const result = { ...failure };
  for (const cat in result) {
    result[cat] = result[cat].map((job) => {
      return { ...job, failure_context: [] };
    });
  }
  return result;
}

/**
 * Returns a list of PR numbers whose Dr. CI comments were updated recently and
 * contain the hourglass icon, indicating that there is a pending job. Used for
 * getting a list of PRs to backfill ex if Dr. CI fails to update the comment
 * due to an error
 * @param repo The repository to search for PRs in. E.g. "pytorch/pytorch"
 * @returns A list of PR numbers
 */
async function getPRsWithPendingJobInComment(repo: String): Promise<number[]> {
  const query = `
select
    issue_comment.issue_url
from
    default.issue_comment final
    join default.pull_request on issue_comment.issue_url = pull_request.issue_url
where
    body like '<!-- drci-comment-start -->%'
    and match(body, '\\d Pending')
    and issue_comment.updated_at > now() - interval 1 month
    and issue_url like {repo: String }
    and pull_request.state = 'open'
`;
  const results = await queryClickhouse(query, { repo: `%${repo}%` });
  return results.map((v) => parseInt(v.issue_url.split("/").pop()));
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

function get_head_branch(_repo: string) {
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
    sha in {shas: Array(String)}
    and merge_base_commit_date != 0
    and repo = {repo: String}
  `;
  const s3client = getS3Client();

  const chMergeBases = new Map(
    (
      await queryClickhouse(mergeBasesQuery, {
        shas: Array.from(workflowsByPR.values()).map((v) => v.head_sha),
        repo: `${OWNER}/${repo}`,
      })
    )?.map((v) => [v.head_sha, v])
  );

  await forAllPRs(
    workflowsByPR,
    async (pr_info: PRandJobs) => {
      const chMergeBase = chMergeBases.get(pr_info.head_sha);
      if (chMergeBase === undefined) {
        // Not found on CH, ask github instead, then put into dynamo, which will
        // get synced with CH
        const diff = await octokit.rest.repos.compareCommits({
          owner: OWNER,
          repo: repo,
          base: pr_info.head_sha,
          head: head,
        });
        pr_info.merge_base = diff.data.merge_base_commit.sha;
        pr_info.merge_base_date =
          diff.data.merge_base_commit.commit.committer?.date ?? "";

        const diffWithMergeBase = await octokit.rest.repos.compareCommits({
          owner: OWNER,
          repo: repo,
          base: pr_info.merge_base,
          head: pr_info.head_sha,
        });

        try {
          const data = {
            sha: pr_info.head_sha,
            merge_base: pr_info.merge_base,
            changed_files: diffWithMergeBase.data.files?.map((e) => e.filename),
            merge_base_commit_date: pr_info.merge_base_date,
            repo: `${OWNER}/${repo}`,
            _id: `${OWNER}-${repo}-${pr_info.head_sha}`,
          };
          s3client.send(
            new PutObjectCommand({
              Bucket: "ossci-raw-job-status",
              Key: `merge_bases/${OWNER}/${repo}/${pr_info.head_sha}.gzip`,
              Body: JSON.stringify(data),
              ContentType: "application/json",
            })
          );
        } catch (e) {
          console.error("Failed to upload to S3", e);
        }
      } else {
        pr_info.merge_base = chMergeBase.merge_base;
        pr_info.merge_base_date = chMergeBase.merge_base_commit_date;
      }
    },
    // NB (huydhn): This function couldn't find merge base for ghstack PR and
    // always throw an error in that case, so I decide to not print anything
    // here to void confusion when seeing this error in the log
    async (pr_info: PRandJobs, _e: Error) => {
      // Insert dummy values if merge base can't be found
      pr_info.merge_base =
        "failed to retrieve merge base, please contact dev infra";
      // NB: Leave the merge base date empty or undefined here, any mock value
      // like 0 is treated as a timestamp to use when quering similar failures
      pr_info.merge_base_date = "";
    }
  );
}

export async function getBaseCommitJobs(
  workflowsByPR: Map<number, PRandJobs>
): Promise<Map<string, Map<string, RecentWorkflowsData[]>>> {
  // get merge base shas
  const baseShas = _.uniq(
    Array.from(workflowsByPR.values()).map((v) => v.merge_base)
  );

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
    const existing_job = jobsBySha.get(job.head_sha).get(job.name);
    if (!existing_job || existing_job.id < job.id) {
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
  issue_url
from
  default.issue_comment final
where
  body like '%<!-- drci-comment-start -->%'
  and issue_url in {prUrls: Array(String)}
    `;
  return new Map(
    (
      await queryClickhouse(existingCommentsQuery, {
        prUrls: Array.from(workflowsByPR.keys()).map(
          (prNumber) =>
            `https://api.github.com/repos/${repoFullName}/issues/${prNumber}`
        ),
      })
    )?.map((v) => [
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
  relatedJobs: Map<number, RecentWorkflowsData> = new Map(),
  relatedIssues: Map<number, IssueData[]> = new Map(),
  relatedInfo: Map<number, string> = new Map()
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
  const jobsSorted = jobs.sort((a, b) => a.name.localeCompare(b.name));
  for (const job of jobsSorted) {
    const isPendingIcon = isPending(job) ? ":hourglass_flowing_sand: " : "";
    output += `* ${isPendingIcon}[${job.name}](${hudPrUrl}#${job.id}) ([gh](${job.html_url}))`;

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
        .map(
          (issue) =>
            `[#${issue.number}](${issue.html_url.replace(
              "https://github.com",
              HUD_URL
            )})`
        )
        .join(", ");
      if (issueInfo) {
        output += ` (${issueInfo})`;
      }
    }

    const info = relatedInfo.get(job.id);
    // Show all the related information
    if (info !== undefined) {
      output += ` (${info})`;
    }

    output += "\n";
    if (job.failure_captures && job.failure_captures.length > 0) {
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
  relatedJobs: Map<number, RecentWorkflowsData>,
  relatedIssues: Map<number, IssueData[]>,
  relatedInfo: Map<number, string>,
  sha: string,
  merge_base: string,
  merge_base_date: string,
  hudBaseUrl: string,
  owner: string,
  repo: string,
  prNumber: number
): string {
  let output = `\n`;
  // Filter out unstable pending jobs
  const unrelatedFailureCount = _(flakyJobs)
    .concat(brokenTrunkJobs)
    .concat(unstableJobs)
    .filter((job) => !isPending(job))
    .value().length;
  const newFailedJobs: RecentWorkflowsData[] = failedJobs.filter(
    (job) =>
      job.conclusion !== "cancelled" &&
      !job.failure_captures.includes(CANCELLED_STEP_ERROR)
  );
  const cancelledJobs: RecentWorkflowsData[] = failedJobs.filter(
    (job) =>
      job.conclusion === "cancelled" ||
      job.failure_captures.includes(CANCELLED_STEP_ERROR)
  );
  const failing = failedJobs.length + unrelatedFailureCount;
  const headerPrefix = `## `;
  const pendingIcon = `:hourglass_flowing_sand:`;
  const successIcon = `:white_check_mark:`;
  const failuresIcon = `:x:`;
  const noneFailing = `No Failures`;
  const significantFailures = `${newFailedJobs.length} New ${pluralize(
    "Failure",
    newFailedJobs.length
  )}`;
  const cancelledFailures = `${cancelledJobs.length} Cancelled ${pluralize(
    "Job",
    cancelledJobs.length
  )}`;
  const unrelatedFailures = `${unrelatedFailureCount} Unrelated ${pluralize(
    "Failure",
    unrelatedFailureCount
  )}`;
  const pendingJobs = `${pending} Pending`;

  const hasAnyFailing = failing > 0;
  const hasSignificantFailures = newFailedJobs.length > 0;
  const hasCancelledFailures = cancelledJobs.length > 0;
  const hasPending = pending > 0;
  const hasUnrelatedFailures = unrelatedFailureCount > 0;

  let icon = "";
  if (hasSignificantFailures || hasCancelledFailures) {
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
  if (hasCancelledFailures) {
    title_messages.push(cancelledFailures);
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
  const timestamp = dayjs.utc(merge_base_date).unix();
  if (!isNaN(timestamp)) {
    output += ` (<sub><sub><img alt="image" width=70 src="https://img.shields.io/date/${timestamp}?label=&color=FFFFFF&style=flat-square"></sub></sub>)`;
  }
  output += ":";

  if (!hasAnyFailing) {
    output += `\n:green_heart: Looks good so far! There are no failures yet. :green_heart:`;
  }

  if (newFailedJobs.length) {
    output += constructResultsJobsSections(
      hudBaseUrl,
      owner,
      repo,
      prNumber,
      `NEW ${pluralize("FAILURE", newFailedJobs.length).toLocaleUpperCase()}`,
      `The following ${
        newFailedJobs.length > 1 ? "jobs have" : "job has"
      } failed`,
      newFailedJobs,
      "",
      false,
      relatedJobs,
      relatedIssues,
      relatedInfo
    );
  }

  if (cancelledJobs.length) {
    output += constructResultsJobsSections(
      hudBaseUrl,
      owner,
      repo,
      prNumber,
      `CANCELLED ${pluralize("JOB", cancelledJobs.length).toLocaleUpperCase()}`,
      `The following ${
        cancelledJobs.length > 1 ? "jobs were" : "job was"
      } cancelled. Please retry`,
      cancelledJobs,
      "",
      true,
      relatedJobs,
      relatedIssues,
      relatedInfo
    );
  }

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
    `The following ${pluralize("job", unstableJobs.length)} ${pluralize(
      "is",
      unstableJobs.length,
      "are"
    )} marked as unstable, possibly due to flakiness on trunk`,
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
      job.name.match(jobNameRegex) &&
      flakyRule.captures.every((capture: string) => {
        const captureRegex = new RegExp(capture);
        const matchFailureCaptures: boolean = job.failure_captures.some(
          (failureCapture) => failureCapture.match(captureRegex)
        );
        const matchFailureLine: boolean =
          job.failure_lines.length > 0 &&
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
  const jobNameNoSuffix = removeJobNameSuffix(job.name);

  // This job doesn't exist in the base commit, thus not a broken trunk failure
  if (!baseJobs.has(jobNameNoSuffix)) {
    return;
  }

  return baseJobs
    .get(jobNameNoSuffix)!
    .find((baseJob) => isSameFailure(baseJob, job));
}

function isPending(job: RecentWorkflowsData): boolean {
  return job.conclusion === "" && isTime0(job.completed_at);
}

export async function getWorkflowJobsStatuses(
  prInfo: PRandJobs,
  flakyRules: FlakyRule[],
  baseJobs: Map<string, RecentWorkflowsData[]>,
  labels: string[] = [],
  unstableIssues: IssueData[] = [],
  disabledTestIssues: IssueData[] = [],
  mergeCommits: string[] = []
): Promise<{
  pending: number;
  failedJobs: RecentWorkflowsData[];
  flakyJobs: RecentWorkflowsData[];
  brokenTrunkJobs: RecentWorkflowsData[];
  unstableJobs: RecentWorkflowsData[];
  relatedJobs: Map<number, RecentWorkflowsData>;
  relatedIssues: Map<number, IssueData[]>;
  relatedInfo: Map<number, string>;
}> {
  let pending = 0;
  const preprocessFailedJobs: RecentWorkflowsData[] = [];
  const flakyJobs: RecentWorkflowsData[] = [];
  const brokenTrunkJobs: RecentWorkflowsData[] = [];
  const unstableJobs: RecentWorkflowsData[] = [];
  const failedJobs: RecentWorkflowsData[] = [];

  // This map holds the list of the base failures for broken trunk jobs or the similar
  // failures for flaky jobs
  const relatedJobs: Map<number, RecentWorkflowsData> = new Map();
  // Maps job id -> associated unstable issue that disables a job
  const relatedIssues: Map<number, IssueData[]> = new Map();
  // Any additional information about the job classification can be kept here
  const relatedInfo: Map<number, string> = new Map();

  for (const job of prInfo.jobs) {
    if (isPending(job)) {
      pending++;
      if (isUnstableJob(job as any, unstableIssues)) {
        unstableJobs.push(job);
        relatedIssues.set(
          job.id,
          getOpenUnstableIssues(job.name, unstableIssues)
        );
      }
    } else if (job.conclusion === "failure" || job.conclusion === "cancelled") {
      const suppressedLabels = await getSuppressedLabels(job, labels);
      if (prInfo.repo === "pytorch" && suppressedLabels.length !== 0) {
        flakyJobs.push(job);
        relatedInfo.set(job.id, `suppressed by ${suppressedLabels.join(", ")}`);
        continue;
      }

      // TODO: remove the `as any` cast when CH migration is complete
      if (isUnstableJob(job as any, unstableIssues)) {
        unstableJobs.push(job);
        relatedIssues.set(
          job.id,
          getOpenUnstableIssues(job.name, unstableIssues)
        );
        continue;
      }

      if (isExcludedFromBrokenTrunk(job)) {
        failedJobs.push(job);
        continue;
      }

      const trunkFailure = getTrunkFailure(job, baseJobs);
      if (trunkFailure !== undefined) {
        brokenTrunkJobs.push(job);
        relatedJobs.set(job.id, trunkFailure);
        continue;
      }

      if (isExcludedFromFlakiness(job)) {
        failedJobs.push(job);
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

      if (await isLogClassifierFailed(job)) {
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
        matchDisabledTestIssues.length !== 0 &&
        isRecentlyCloseDisabledTest(
          matchDisabledTestIssues,
          prInfo.merge_base_date
        )
      ) {
        const disabledTestIssuesMsg = matchDisabledTestIssues
          .map(
            (issue) =>
              `[#${issue.number}](${issue.html_url.replace(
                "https://github.com",
                HUD_URL
              )})`
          )
          .join(", ");
        relatedInfo.set(
          job.id,
          `disabled by ${disabledTestIssuesMsg} but the issue was closed recently and a rebase is needed to make it pass`
        );

        if (!isDisabledTestMentionedInPR(matchDisabledTestIssues, prInfo)) {
          flakyJobs.push(job);
          continue;
        }
      }

      if (
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
            .map(
              (issue) =>
                `[#${issue.number}](${issue.html_url.replace(
                  "https://github.com",
                  HUD_URL
                )})`
            )
            .join(", ");
          relatedInfo.set(job.id, `disabled by ${disabledTestIssuesMsg}`);
          continue;
        }
      }

      if (prInfo.repo === "pytorch") {
        // NB: Searching for similar failures depends on the accuracy of the log
        // classifier, so we only enable this in PyTorch core atm where the log
        // classifier works decently well
        const similarFailure = await hasSimilarFailures(
          job,
          prInfo.merge_base_date,
          mergeCommits
        );
        if (similarFailure !== undefined) {
          flakyJobs.push(job);
          relatedJobs.set(job.id, similarFailure);
          continue;
        }
      }

      preprocessFailedJobs.push(job);
    }
  }

  // Verify that the failed job is unique and there is no similar flaky, broken trunk,
  // or unstable jobs in the same pull request. If there are some, these failures are
  // also considered unrelated
  for (const job of preprocessFailedJobs) {
    // If the failure is a generic error, don't do anything because we run the
    // risk of getting false positives
    if (isExcludedFromSimilarityPostProcessing(job)) {
      failedJobs.push(job);
      continue;
    }

    // Some jobs are marked as unstable while similar ones are not, i.e. different CUDA/python versions
    const similarUnstableFailure = hasSimilarFailuresInSamePR(
      job,
      unstableJobs
    );
    if (similarUnstableFailure !== undefined) {
      unstableJobs.push(job);
      relatedJobs.set(job.id, similarUnstableFailure);
      continue;
    }

    // Searching for similar flaky failures miss this case
    const similarFlakyFailure = hasSimilarFailuresInSamePR(job, flakyJobs);
    if (similarFlakyFailure !== undefined) {
      flakyJobs.push(job);
      relatedJobs.set(job.id, similarFlakyFailure);
      continue;
    }

    // Broken trunk between trunk and periodic jobs
    const similarBrokenTrunkFailure = hasSimilarFailuresInSamePR(
      job,
      brokenTrunkJobs
    );
    if (similarBrokenTrunkFailure !== undefined) {
      flakyJobs.push(job);
      relatedJobs.set(job.id, similarBrokenTrunkFailure);
      continue;
    }

    failedJobs.push(job);
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
  // Dedup because the input can contain the same job multiple times due to the
  // two queries for recent workflows and for comments with pending jobs
  const dedupedRecentWorkflows = _.uniqBy(recentWorkflows, (workflow) =>
    JSON.stringify([
      workflow.id,
      workflow.workflowId,
      workflow.head_sha,
      workflow.pr_number,
      workflow.name,
    ])
  );
  const workflowsByPR: PRandJobs[] = await Promise.all(
    _(dedupedRecentWorkflows)
      .groupBy("pr_number")
      .map(async (workflows, prNumber) => {
        // NB: The head SHA timestamp is currently used as the end date when
        // searching for similar failures.  However, it's not available on CH for
        // commits from forked PRs before a ciflow ref is pushed.  In such case,
        // the head SHA timestamp will be undefined and we will make an additional
        // query to GitHub to get the value
        let headShaTimestamp = workflows.find(
          (workflow) => !isTime0(workflow.head_sha_timestamp)
        )?.head_sha_timestamp;
        if (octokit && headShaTimestamp === undefined) {
          headShaTimestamp = await fetchCommitTimestamp(
            octokit,
            owner,
            repo,
            workflows[0].head_sha
          );
        }
        workflows.forEach((workflow) => {
          if (isTime0(workflow.head_sha_timestamp) && headShaTimestamp) {
            workflow.head_sha_timestamp = headShaTimestamp;
          }
        });

        let prTitle = "";
        let prBody = "";
        let prShas: { sha: string; title: string }[] = [];
        // Gate this to PyTorch as disabled tests feature is only available there
        if (octokit && repo === "pytorch") {
          const prData = await fetchPR(owner, repo, `${prNumber}`, octokit);
          prTitle = prData.title;
          prBody = prData.body;
          prShas = prData.shas;
        }

        return {
          pr_number: parseInt(prNumber),
          head_sha: workflows[0].head_sha,
          head_sha_timestamp: headShaTimestamp ?? "",
          jobs: workflows,
          merge_base: "",
          merge_base_date: "",
          owner: owner,
          repo: repo,
          title: prTitle,
          body: prBody,
          shas: prShas,
        };
      })
      .value()
  );

  // clean up the workflows - remove retries, remove workflows that have jobs,
  // remove cancelled jobs with weird names
  for (const prInfo of workflowsByPR) {
    const [workflows, jobs] = _.partition(
      prInfo.jobs,
      (job) => job.workflowId === 0
    );

    // Get most recent workflow run based on workflowUniqueId (workflow_id in webhooks)
    const recentWorkflows: Map<number, RecentWorkflowsData> = new Map();
    for (const workflow of workflows) {
      // Check that this is a workflow, not a job
      const workflowUniqueId = workflow.workflowUniqueId;
      const existingWorkflowId = recentWorkflows.get(workflowUniqueId)?.id;
      if (!existingWorkflowId || existingWorkflowId < workflow.id) {
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
      const key = job.name;
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
  return workflowsByPR.reduce((acc, prInfo) => {
    acc.set(prInfo.pr_number, prInfo);
    return acc;
  }, new Map<number, PRandJobs>());
}
