import dayjs from "dayjs";
import { jaroWinkler } from "jaro-winkler-typescript";
import {
  BasicJobData,
  IssueData,
  JobData,
  PRandJobs,
  RecentWorkflowsData,
} from "lib/types";
import _, { isEqual } from "lodash";
import TrieSearch from "trie-search";

export const REMOVE_JOB_NAME_SUFFIX_REGEX = new RegExp(
  ", [0-9]+, [0-9]+, .+\\)"
);

export const EXTRACT_REPO_NAME_REGEX = new RegExp(
  "^.+/github\\.com/(?<repo>.+)/actions/runs/.+$"
);

export const FAILED_TEST_REGEX = new RegExp(
  "(?<testfile>.+)::(?<testclass>.+)::(?<testcase>.+)"
);

export const STRING_SIMILARITY_THRESHOLD = 0.95;

export function isFailedJob(job: JobData) {
  return (
    job.conclusion === "failure" ||
    job.conclusion === "cancelled" ||
    job.conclusion === "timed_out"
  );
}

export function isCancellationSuccessJob(job: JobData) {
  // job was cancelled successfully
  return (
    job.conclusion === "cancelled" &&
    (!job.failureLines ||
      job.failureLines.length == 0 ||
      job.failureLines[0]?.includes("was canceled"))
  );
}

export function isSuccessJob(job: BasicJobData) {
  return job.conclusion === "success";
}

export function isMatchingJobByName(job: JobData, name: string) {
  // Somehow, JobData has both name and jobName field.  They can be populated
  // by different queries, so we need to check both
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

export function isUnstableJob(
  job: JobData,
  unstableIssues?: IssueData[]
): boolean {
  // The name has the unstable keywork, the job is unstable
  if (isMatchingJobByName(job, "unstable")) {
    return true;
  }

  const openUnstableIssues = getOpenUnstableIssues(job.name, unstableIssues);
  return openUnstableIssues !== undefined && openUnstableIssues.length !== 0;
}

export function getOpenUnstableIssues(
  jobName?: string,
  unstableIssues?: IssueData[]
): IssueData[] {
  // Passing job name as a string here so that this function can be reused by functions in JobClassifierUtil
  // which only have the job name to group jobs
  if (!jobName) {
    return [];
  }

  if (unstableIssues === undefined || unstableIssues === null) {
    return [];
  }

  // For PT build jobs and Nova jobs from other repos, there is no clear way to change
  // their names to include the unstable keywork atm. So, we need to double check the
  // list of unstable jobs
  const transformedJobName = transformJobName(jobName);
  // Ignore invalid job name
  if (transformedJobName === null) {
    return [];
  }

  const issueTitle = `UNSTABLE ${transformedJobName}`;
  return unstableIssues.filter(
    (issue) => issueTitle.includes(issue.title) && issue.state === "open"
  );
}

export function isDisabledTest(matchDisabledTestIssues: IssueData[]): boolean {
  return matchDisabledTestIssues.some(
    (disabledTestIssue) => disabledTestIssue.state === "open"
  );
}

export function isDisabledTestMentionedInPR(
  matchDisabledTestIssues: IssueData[],
  prInfo: PRandJobs
): boolean {
  // This captures the rule in PyTorch CI that if the disabled issue is mentioned
  // anywhere in the PR body or commit, the test should be run instead of skipping
  // by the PR
  return matchDisabledTestIssues.some((disabledTestIssue) => {
    // NB: This is the same regex used by filter_test_configs script
    const reenableTestRegex = new RegExp(
      `(Close(d|s)?|Resolve(d|s)?|Fix(ed|es)?) (#|https://github.com/pytorch/pytorch/issues/)${disabledTestIssue.number}`,
      "i"
    );
    return (
      prInfo.body.match(reenableTestRegex) ||
      prInfo.shas.some((commit) => commit.title.match(reenableTestRegex))
    );
  });
}

export function isRecentlyCloseDisabledTest(
  matchDisabledTestIssues: IssueData[],
  baseCommitDate: string
): boolean {
  // If there is one open disabled issue associated with the failed test, it's
  // obviously not a recently closed one
  if (isDisabledTest(matchDisabledTestIssues)) {
    return false;
  }

  // We need the base commit date for the comparison, so there is nothing to
  // say if the value is not there
  if (!baseCommitDate) {
    return false;
  }

  const closeTimestamp = _.max(
    matchDisabledTestIssues.map((disabledTestIssue) =>
      dayjs(disabledTestIssue.updated_at)
    )
  );
  // If the base commit timestamp is before the closing time of the issue, it
  // won't have the commit that fixes the flaky test. So, it's ok if the test
  // fails
  return dayjs(baseCommitDate).isBefore(dayjs(closeTimestamp));
}

export function getDisabledTestIssues(
  job: RecentWorkflowsData,
  disabledTestIssues: IssueData[]
): IssueData[] {
  if (job.name == "" || job.failure_captures.length === 0) {
    return [];
  }

  const matchingIssues: IssueData[] = [];
  for (const failureCapture of job.failure_captures) {
    const matchTest = failureCapture.match(FAILED_TEST_REGEX);
    if (!matchTest || !matchTest.groups) {
      continue;
    }

    const testclass = matchTest.groups.testclass;
    const testcase = matchTest.groups.testcase;

    const matchingIssue = disabledTestIssues.filter((disabledTestIssue) => {
      const title = disabledTestIssue.title;
      if (
        !title.includes(`DISABLED ${testcase}`) ||
        !title.includes(testclass)
      ) {
        return false;
      }

      // Get the list of platforms where the test is disabled
      const platformsMatch = disabledTestIssue.body.match(
        new RegExp("Platforms: (?<platforms>[\\w,\\t ]*)")
      );
      if (!platformsMatch || !platformsMatch.groups) {
        // Note that if the list of platforms is not set, the default is to disabled
        // the test on all of them
        return true;
      }

      return _.some(
        platformsMatch.groups.platforms
          .split(",")
          .map((platform) => platform.trim()),
        (platform) => job.name.includes(platform)
      );
    });

    matchingIssues.push(...matchingIssue);
  }

  return matchingIssues;
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
  jobB: RecentWorkflowsData,
  doJobNameCheck: boolean = true
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

  if (doJobNameCheck && jobANameNoSuffix !== jobBNameNoSuffix) {
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
