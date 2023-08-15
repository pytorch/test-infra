import _ from "lodash";
import { getOctokit, commitDataFromResponse } from "./github";
import getRocksetClient from "./rockset";
import rocksetVersions from "rockset/prodVersions.json";

import { CommitData, JobData } from "./types";

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

  return {
    commit: commitDataFromResponse(githubResponse.data),
    jobs,
  };
}

export async function fetchBaseCommitTimeStamp(
  baseCommitSha: string
): Promise<string> {
  if (baseCommitSha === "") {
    return "";
  }

  const rocksetClient = getRocksetClient();
  // Decide to get the commit timestamp from merges collection instead because
  // it's small. But this only works for base commits in trunk. May be we can
  // refactor this later on to a proper query lambda that handles any commits
  const rocksetQuery = await rocksetClient.queries.query({
    sql: {
      query:
        "SELECT _event_time AS time FROM commons.merges WHERE merge_commit_sha = :sha",
      parameters: [
        {
          name: "sha",
          type: "string",
          value: baseCommitSha,
        },
      ],
      default_row_limit: 1,
    },
  });

  if (rocksetQuery.results === undefined || rocksetQuery.results.length === 0) {
    return "";
  }

  // There is at most one record
  return rocksetQuery.results[0].time;
}
