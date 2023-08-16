import getRocksetClient from "./rockset";
import rocksetVersions from "rockset/prodVersions.json";
import { isEqual } from "lodash";
import { RecentWorkflowsData, JobData } from "lib/types";

export const REMOVE_JOB_NAME_SUFFIX_REGEX = new RegExp(
  ", [0-9]+, [0-9]+, .+\\)"
);
export const GHSTACK_SUFFIX_REGEX = new RegExp("/[0-9]+/head");

export function isFailedJob(job: JobData) {
  return (
    job.conclusion === "failure" ||
    job.conclusion === "cancelled" ||
    job.conclusion === "timed_out"
  );
}

export function isMatchingJobByName(job: JobData, name: string) {
  // Somehow, JobData has both name and jobName field.  They can be populated
  // by different rockset query, so we need to check both
  return (
    (job.name !== undefined && job.name.includes(name)) ||
    (job.jobName !== undefined && job.jobName.includes(name))
  );
}

export function isRerunDisabledTestsJob(job: JobData) {
  // Rerunning disabled tests are expected to fail from time to time depending
  // on the nature of the disabled tests, so we don't want to count them sometimes
  return isMatchingJobByName(job, "rerun_disabled_tests");
}

export function isUnstableJob(job: JobData) {
  return isMatchingJobByName(job, "unstable");
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

export function isSameHeadBranch(
  branchA: string | null | undefined,
  branchB: string | null | undefined
): boolean {
  if (!branchA || !branchB) {
    return false;
  }

  const replaceWith = "";
  // This function exists because we want to treat all ghstack head branches
  // as one branch when it comes to finding similar failures. A legit failure
  // coming from the same job but different commits in the stack shouldn't be
  // treated as a flaky similar failure
  const branchANoGhstack = branchA.replace(GHSTACK_SUFFIX_REGEX, replaceWith);
  const branchBNoGhstack = branchB.replace(GHSTACK_SUFFIX_REGEX, replaceWith);

  return branchANoGhstack === branchBNoGhstack;
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
    isEqual(jobA.failure_captures, jobB.failure_captures)
  );
}
