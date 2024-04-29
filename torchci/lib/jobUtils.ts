import _ from "lodash";
import dayjs from "dayjs";
import TrieSearch from "trie-search";
import getRocksetClient from "./rockset";
import rocksetVersions from "rockset/prodVersions.json";
import { isEqual } from "lodash";
import {
  RecentWorkflowsData,
  JobData,
  BasicJobData,
  IssueData,
} from "lib/types";
import { getAuthors } from "lib/getAuthors";
import { jaroWinkler } from "jaro-winkler-typescript";

export const REMOVE_JOB_NAME_SUFFIX_REGEX = new RegExp(
  ", [0-9]+, [0-9]+, .+\\)"
);

export const EXTRACT_REPO_NAME_REGEX = new RegExp(
  "^.+/github\\.com/(?<repo>.+)/actions/runs/.+$"
);

export const STRING_SIMILARITY_THRESHOLD = 0.95;

export function isFailedJob(job: JobData) {
  return (
    job.conclusion === "failure" ||
    job.conclusion === "cancelled" ||
    job.conclusion === "timed_out"
  );
}

export function isSuccessJob(job: BasicJobData) {
  return job.conclusion === "success";
}

export function isMatchingJobByName(job: JobData, name: string) {
  // Somehow, JobData has both name and jobName field.  They can be populated
  // by different rockset query, so we need to check both
  return (
    (job.name !== undefined && job.name.includes(name)) ||
    (job.jobName !== undefined && job.jobName.includes(name))
  );
}

const jobNameRe = /^(.*) \(([^,]*),.*\)/;
export function transformJobName(jobName?: string) {
  if (jobName == undefined) {
    return null;
  }

  // We want to have the job name in the following format WORKFLOW / JOB (CONFIG)
  const jobNameMatch = jobName.match(jobNameRe);
  if (jobNameMatch !== null) {
    return `${jobNameMatch[1]} (${jobNameMatch[2]})`;
  }

  return jobName;
}

export function isRerunDisabledTestsJob(job: JobData) {
  // Rerunning disabled tests are expected to fail from time to time depending
  // on the nature of the disabled tests, so we don't want to count them sometimes
  return isMatchingJobByName(job, "rerun_disabled_tests");
}

export function isUnstableJob(job: JobData, unstableIssues?: IssueData[]) {
  // The name has the unstable keywork, the job is unstable
  if (isMatchingJobByName(job, "unstable")) {
    return true;
  }

  return hasOpenUnstableIssue(job.name, unstableIssues);
}

export function hasOpenUnstableIssue(
  jobName?: string,
  unstableIssues?: IssueData[]
) {
  // Passing job name as a string here so that this function can be reused by functions in JobClassifierUtil
  // which only have the job name to group jobs
  if (!jobName) {
    return false;
  }

  if (unstableIssues === undefined || unstableIssues === null) {
    return false;
  }

  // For PT build jobs and Nova jobs from other repos, there is no clear way to change
  // their names to include the unstable keywork atm. So, we need to double check the
  // list of unstable jobs
  const transformedJobName = transformJobName(jobName);
  // Ignore invalid job name
  if (transformedJobName === null) {
    return false;
  }

  const issueTitle = `UNSTABLE ${transformedJobName}`;
  const matchingIssues = unstableIssues.filter(
    (issue) => issueTitle.includes(issue.title) && issue.state === "open"
  );

  return matchingIssues.length !== 0;
}

export async function getFlakyJobsFromPreviousWorkflow(
  owner: string,
  repo: string,
  branch: string,
  workflowName: string,
  workflowId: number
): Promise<any> {
  const rocksetClient = getRocksetClient();
  const query = await rocksetClient.queryLambdas.executeQueryLambda(
    "commons",
    "flaky_workflows_jobs",
    rocksetVersions.commons.flaky_workflows_jobs,
    {
      parameters: [
        {
          name: "repo",
          type: "string",
          value: `${owner}/${repo}`,
        },
        {
          name: "workflowNames",
          type: "string",
          value: workflowName,
        },
        {
          name: "nextWorkflowId",
          type: "int",
          value: `${workflowId}`, // Query the flaky status of jobs from the previous workflow
        },
        {
          name: "branches",
          type: "string",
          value: branch,
        },
        {
          name: "maxAttempt",
          type: "int",
          value: "1", // If the job was retried and still failed, it wasn't flaky
        },
      ],
    }
  );

  const flakyJobs = query.results;
  if (flakyJobs === undefined || flakyJobs.length === 0) {
    return [];
  }

  // The query returns all the flaky jobs from the previous workflow
  return flakyJobs;
}

export function removeJobNameSuffix(
  jobName: string,
  replaceWith: string = ")"
): string {
  if (!jobName) {
    return jobName;
  }

  return jobName.replace(REMOVE_JOB_NAME_SUFFIX_REGEX, replaceWith);
}

export async function hasS3Log(job: RecentWorkflowsData): Promise<boolean> {
  // This is to handle the infra flaky issue where the log is not available on
  // S3 and no failure is found.
  // NB: PyTorch uses the shortcut /log/JOB_ID path while other repos require
  // the path to be set explicitly, i.e. /log/pytorch/executorch/JOB_ID
  const m =
    job.html_url !== undefined
      ? job.html_url.match(EXTRACT_REPO_NAME_REGEX)
      : null;
  // Default to pytorch/pytorch
  const repo =
    m !== null && m.groups !== undefined ? m.groups.repo : "pytorch/pytorch";
  const path = repo === "pytorch/pytorch" ? "/" : `/${repo}/`;
  const url = `https://ossci-raw-job-status.s3.amazonaws.com/log${path}${job.id}`;

  const res = await fetch(url, { method: "HEAD" });
  return res.status !== 404;
}

export async function backfillMissingLog(
  owner: string,
  repo: string,
  job: RecentWorkflowsData
): Promise<boolean> {
  // This creates a mock GitHub workflow_job completion event to reupload the log
  // to S3 and trigger log classifier. The action is set to backfill to tell the
  // lambda code that this is a mock event body. Note that backfill is not a GitHub
  // event actions
  const body = {
    action: "backfill",
    repository: {
      full_name: `${owner}/${repo}`,
    },
    workflow_job: {
      conclusion: job.conclusion,
      id: job.id,
    },
  };
  const res = await fetch(
    "https://jqogootqqe.execute-api.us-east-1.amazonaws.com/default/github-status-test",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-GitHub-Event": "workflow_job",
      },
      body: JSON.stringify(body),
    }
  );
  return res.status === 200;
}

export async function isSameAuthor(
  job: RecentWorkflowsData,
  failure: RecentWorkflowsData
): Promise<boolean> {
  const authors = await getAuthors([job, failure]);
  // Extract the authors for each job
  const jobAuthor =
    job.head_sha in authors
      ? authors[job.head_sha]
      : { email: "", commit_username: "", pr_username: "" };
  const failureAuthor =
    failure.head_sha in authors
      ? authors[failure.head_sha]
      : { email: "", commit_username: "", pr_username: "" };

  const isSameEmail =
    jobAuthor.email !== "" &&
    failureAuthor.email !== "" &&
    jobAuthor.email === failureAuthor.email;
  const isSameCommitUsername =
    jobAuthor.commit_username !== "" &&
    failureAuthor.commit_username !== "" &&
    jobAuthor.commit_username === failureAuthor.commit_username;
  const isSamePrUsername =
    jobAuthor.pr_username !== "" &&
    failureAuthor.pr_username !== "" &&
    jobAuthor.pr_username === failureAuthor.pr_username;

  // This function exists because we don't want to wrongly count similar failures
  // from commits of the same author as flaky. Some common cases include:
  // * ghstack
  // * Draft commit
  // * Cherry picking
  return isSameEmail || isSameCommitUsername || isSamePrUsername;
}

export async function getPRMergeCommits(
  job: RecentWorkflowsData
): Promise<String[]> {
  // No a PR job
  if (!job.pr_number) {
    return [];
  }

  // Sort by comment ID desc because we don't want to depend on _event_time in
  // general
  const query = `
SELECT
  merge_commit_sha,
FROM
  commons.merges
WHERE
  pr_num = :pr_num
ORDER BY
  comment_id DESC
  `;

  const rocksetClient = getRocksetClient();
  const results = (
    await rocksetClient.queries.query({
      sql: {
        query: query,
        parameters: [
          {
            name: "pr_num",
            type: "int",
            value: job.pr_number.toString(),
          },
        ],
      },
    })
  ).results;

  // The PR hasn't been merged yet
  return results !== undefined
    ? _.map(results, (record) => record.merge_commit_sha)
    : [];
}

export function isFailureFromPrevMergeCommit(
  failure: RecentWorkflowsData,
  mergeCommits: String[]
): boolean {
  // Not coming from main, it couldn't be a failure coming from the merge commit
  if (!failure.head_branch || failure.head_branch !== "main") {
    return false;
  }

  return _.find(mergeCommits, (commit) => commit === failure.head_sha) !==
    undefined
    ? true
    : false;
}

export function isSameFailure(
  jobA: RecentWorkflowsData,
  jobB: RecentWorkflowsData
): boolean {
  if (
    jobA.name === undefined ||
    jobA.name === "" ||
    jobB.name === undefined ||
    jobB.name === ""
  ) {
    return false;
  }

  // Return true if two jobs have the same failures. This is used to figure out
  // broken trunk and other similar failures
  const jobANameNoSuffix = removeJobNameSuffix(jobA.name);
  const jobBNameNoSuffix = removeJobNameSuffix(jobB.name);

  if (jobANameNoSuffix !== jobBNameNoSuffix) {
    return false;
  }

  return (
    jobA.conclusion === jobB.conclusion &&
    isEqual(jobA.failure_captures, jobB.failure_captures) &&
    isSameContext(jobA, jobB)
  );
}

export function isSameContext(
  jobA: RecentWorkflowsData,
  jobB: RecentWorkflowsData
): boolean {
  const jobAHasFailureContext =
    jobA.failure_context !== null &&
    jobA.failure_context !== undefined &&
    jobA.failure_context.length !== 0;
  const jobBHasFailureContext =
    jobB.failure_context !== null &&
    jobB.failure_context !== undefined &&
    jobB.failure_context.length !== 0;

  if (!jobAHasFailureContext && !jobBHasFailureContext) {
    return true;
  }

  if (!jobAHasFailureContext || !jobBHasFailureContext) {
    return false;
  }

  // NB: The failure context is a few experiment feature showing the last
  // N bash commands before the failure occurs. So, let's check only the
  // last command for now and see how it goes
  const jobALastCmd = jobA.failure_context![0] ?? "";
  const jobBLastCmd = jobB.failure_context![0] ?? "";

  // Use fuzzy string matching here because context commands could vary
  // slightly, for example, run_test command on different shards
  return (
    jaroWinkler(jobALastCmd, jobBLastCmd, { caseSensitive: false }) >=
    STRING_SIMILARITY_THRESHOLD
  );
}

export function removeCancelledJobAfterRetry<T extends BasicJobData>(
  jobs: T[]
): T[] {
  // When a worlflow is manually cancelled and retried, the leftover cancel signals from
  // the previous workflow run are poluting HUD and Dr.CI. For example, the pull request
  // https://hud.pytorch.org/pytorch/pytorch/pull/107339 had many cancelled binary build
  // jobs showing up as new failures after the workflow had been retried successfully.
  //
  // The issue here is that the cancelled job name is not the same as the successfully
  // retried one, for example manywheel-py3_10-cuda11_8-test (cancel) was retried as
  // manywheel-py3_10-cuda11_8-test / test (success). As their names look different,
  // HUD and Dr.CI treat them incorrectly as two different jobs and mark the cancelled
  // one as a failure.
  //
  // So the fix here is to check if a cancelled job has been retried successfully and
  // keep or remove it from the list accordingly.
  const trie: TrieSearch<T> = new TrieSearch<T>("name", {
    splitOnRegEx: /\//g,
  });
  trie.addAll(jobs);

  const processedJobName: Set<string> = new Set<string>();
  const filteredJobs: T[] = [];

  for (const job of jobs) {
    if (job.name === undefined) {
      continue;
    }

    let currentMatch: T | undefined = undefined;
    let currentLatestTimestamp = dayjs(0);

    const matches = trie.search(job.name);
    if (matches.length <= 1) {
      // If there is zero or one match, keep the job as it is as this is no retry
      currentMatch = job;
    } else {
      // NB: Default to the latest successful job. This is needed because the event
      // time from GitHub does not guarantee strict chronological order. A quick
      // retry event could have a timestamp few seconds earlier than the original
      // job. We are getting the last successful job here (if any)
      currentMatch = _.find(matches, (match: T) => isSuccessJob(match));
      if (currentMatch !== undefined) {
        currentLatestTimestamp = dayjs(currentMatch.time);
      }

      // When there are multiple matches, they are retried, so keep the latest one.
      // Note that if the latest one was cancelled, it would still show up on HUD
      // as expected
      for (const match of matches) {
        const timestamp = dayjs(match.time);
        if (timestamp.isAfter(currentLatestTimestamp, "minute")) {
          currentMatch = match;
          currentLatestTimestamp = timestamp;
        }
      }
    }

    if (
      currentMatch !== undefined &&
      !processedJobName.has(currentMatch.name!)
    ) {
      processedJobName.add(currentMatch.name!);
      filteredJobs.push(currentMatch);
    }
  }

  return filteredJobs;
}
