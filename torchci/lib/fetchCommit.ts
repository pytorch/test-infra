import _ from "lodash";
import { Octokit } from "octokit";
import rocksetVersions from "rockset/prodVersions.json";
import { enableClickhouse, queryClickhouseSaved } from "./clickhouse";
import { commitDataFromResponse, getOctokit } from "./github";
import { removeCancelledJobAfterRetry } from "./jobUtils";
import getRocksetClient from "./rockset";
import { CommitData, JobData } from "./types";

async function fetchDatabaseInfo(owner: string, repo: string, sha: string) {
  if (enableClickhouse()) {
    const response = queryClickhouseSaved("commit_jobs_query", {
      repo: `${owner}/${repo}`,
      sha: sha,
    });
    return response;
  } else {
    const rocksetClient = getRocksetClient();
    const response = await rocksetClient.queryLambdas.executeQueryLambda(
      "commons",
      "commit_jobs_query",
      rocksetVersions.commons.commit_jobs_query as string,
      {
        parameters: [
          {
            name: "sha",
            type: "string",
            value: sha,
          },
          {
            name: "repo",
            type: "string",
            value: `${owner}/${repo}`,
          },
        ],
      }
    );
    return response.results!;
  }
}

export default async function fetchCommit(
  owner: string,
  repo: string,
  sha: string
): Promise<{ commit: CommitData; jobs: JobData[] }> {
  // Retrieve commit data from GitHub
  const octokit = await getOctokit(owner, repo);

  const [githubResponse, response] = await Promise.all([
    octokit.rest.repos.getCommit({ owner, repo, ref: sha }),
    await fetchDatabaseInfo(owner, repo, sha),
  ]);

  let jobs = response as any[];

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
    (job) => job.workflowId === null || job.workflowId === undefined
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
