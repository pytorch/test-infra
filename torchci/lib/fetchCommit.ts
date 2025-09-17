import _ from "lodash";
import { Octokit } from "octokit";
import {
  CommitApiResponse,
  WorkflowRunInfo,
} from "pages/api/[repoOwner]/[repoName]/commit/[sha]";
import { queryClickhouseSaved } from "./clickhouse";
import { commitDataFromResponse, getOctokit } from "./github";
import { removeCancelledJobAfterRetry } from "./jobUtils";
import { JobData } from "./types";

async function fetchDatabaseInfo(
  owner: string,
  repo: string,
  sha: string,
  workflowId: number,
  runAttempt: number
) {
  const response = await queryClickhouseSaved("commit_jobs_query", {
    repo: `${owner}/${repo}`,
    sha: sha,
    workflowId,
    runAttempt,
  });

  for (const row of response) {
    // TODO: change the code that relies id and workflowId being null to handle
    // 0 instead?
    row.id = row.id == 0 ? null : row.id;
    row.workflowId = row.workflowId == 0 ? null : row.workflowId;
  }
  return response;
}

/**
 * Get a mapping of workflow names to all workflow IDs from a list of job data.
 * @param jobs
 * @returns
 */
function getWorkflowIdsByName(
  jobs: JobData[]
): Record<string, [WorkflowRunInfo]> {
  return _(jobs)
    .groupBy((job) => job.workflowName)
    .map((jobs, key) => {
      const idAndAttempts = _(jobs)
        .map((job) => {
          return {
            id: job.workflowId,
            attempt: job.runAttempt,
          };
        })
        .filter(
          (id) =>
            id.id !== null &&
            id.id !== undefined &&
            id.attempt !== null &&
            id.attempt !== undefined
        )
        .uniqBy((id) => `${id.id}-${id.attempt}`)
        .value();
      return [key, idAndAttempts];
    })
    .fromPairs()
    .value();
}

/**
 *
 * @param owner
 * @param repo
 * @param sha
 * @param workflowId Optional workflow ID to filter jobs by. If not provided,
 * all jobs for the commit will be returned.
 * @returns
 */
export default async function fetchCommit(
  owner: string,
  repo: string,
  sha: string,
  workflowId: number = 0,
  runAttempt: number = 0
): Promise<CommitApiResponse> {
  // Retrieve commit data from GitHub
  const octokit = await getOctokit(owner, repo);

  const [githubResponse, response] = await Promise.all([
    octokit.rest.repos.getCommit({ owner, repo, ref: sha }),
    await fetchDatabaseInfo(owner, repo, sha, workflowId, runAttempt),
  ]);

  let jobs = response as any[];

  const workflowIdsByName = getWorkflowIdsByName(jobs);

  // Subtle: we need to unique jobs by name, taking the most recent job. This is
  // because there might be many periodic jobs with the same name, and we want
  // to avoid noising up the display with many duplicate jobs.
  jobs = _.sortBy(jobs, "id").reverse();
  jobs = _.uniqBy(jobs, "name");
  // Now sort alphabetically by name.
  jobs = _.sortBy(jobs, "name");

  // Handle workflow start up failures by handling jobs and workflows separately
  // and then merging them back together
  const [workflows, onlyJobs] = _.partition(
    jobs,
    (job) =>
      job.workflowId === null ||
      job.workflowId === undefined ||
      job.workflowId === 0
  );

  const filteredJobs = removeCancelledJobAfterRetry<JobData>(onlyJobs);

  const workflowIdsWithJobs = _.map(filteredJobs, (job) => job.workflowId);

  const badWorkflows = _.filter(
    workflows,
    (workflow) => !workflowIdsWithJobs.includes(workflow.id)
  );

  return {
    commit: commitDataFromResponse(githubResponse.data),
    jobs: _.concat(filteredJobs, badWorkflows),
    workflowIdsByName,
  };
}

export async function fetchCommitTimestamp(
  octokit: Octokit,
  owner: string,
  repo: string,
  commit_sha: string
): Promise<string> {
  // Query GitHub to get the commit timestamp, this is used to get the timestamp of
  // commits from forked PRs
  const commit = await octokit.rest.git.getCommit({
    owner: owner,
    repo: repo,
    commit_sha: commit_sha,
  });

  return commit.data.committer.date;
}
