import _ from "lodash";
import { getOctokit, commitDataFromResponse } from "./github";
import getRocksetClient from "./rockset";
import rocksetVersions from "rockset/prodVersions.json";

import { CommitData, JobData } from "./types";
import { removeCancelledJobAfterRetry } from "./jobUtils";

export default async function fetchCommit(
  owner: string,
  repo: string,
  sha: string
): Promise<{ commit: CommitData; jobs: JobData[] }> {
  // Retrieve commit data from GitHub
  const octokit = await getOctokit(owner, repo);
  const rocksetClient = getRocksetClient();

  const [githubResponse, commitJobsQuery] = await Promise.all([
    octokit.rest.repos.getCommit({ owner, repo, ref: sha }),
    await rocksetClient.queryLambdas.executeQueryLambda(
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
    ),
  ]);

  let jobs = commitJobsQuery.results!;
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

  for (const debug of onlyJobs) {
    if (debug["jobName"] === "linux-jammy-py3.8-gcc11 / build") {
      console.log(JSON.stringify(debug));
    }
  }
  console.log("DONE");

  const filteredJobs = removeCancelledJobAfterRetry<JobData>(onlyJobs);

  // for (const debug of filteredJobs) {
  //   if (debug["jobName"] === "linux-jammy-py3.8-gcc11 / build") {
  //     console.log(JSON.stringify(debug));
  //   }
  // }
  console.log("REALLY");
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
