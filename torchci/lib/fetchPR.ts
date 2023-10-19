import { getOctokit } from "./github";
import getRocksetClient from "./rockset";
import rocksetVersions from "rockset/prodVersions.json";
import { PRData } from "./types";

export default async function fetchPR(
  owner: string,
  repo: string,
  prNumber: string
): Promise<PRData> {
  // First pull data from Rockset to get everything including commits that have been force merged past.
  // Then pull data from GitHub to get anything newer that was missed.

  const rocksetClient = getRocksetClient();

  const octokit = await getOctokit(owner, repo);
  const [pull, commits, historicalCommits] = await Promise.all([
    octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: parseInt(prNumber),
    }),
    octokit.paginate(octokit.rest.pulls.listCommits, {
      owner,
      repo,
      pull_number: parseInt(prNumber),
      per_page: 100,
    }),
    await rocksetClient.queryLambdas.executeQueryLambda(
      "commons",
      "pr_commits",
      rocksetVersions.commons.pr_commits as string,
      {
        parameters: [
          {
            name: "pr_num",
            type: "int",
            value: prNumber,
          },
          {
            name: "owner",
            type: "string",
            value: owner,
          },
          {
            name: "repo",
            type: "string",
            value: repo,
          },
        ],
      }
    ),
  ]);
  const title = pull.data.title;

  let shas = historicalCommits.results!.map((commit) => {
    return { sha: commit.sha, title: commit.message.split("\n")[0] };
  });

  // Ideally historicalCommits will be a superset of commits, but if there's a propagation delay with
  // getting the data to rockset it may be missing recent commits for a bit.
  if (shas.length == 0) {
    // If we got no data from rockset, just use the commits from GitHub.
    shas = commits.map((commit) => {
      return { sha: commit.sha, title: commit.commit.message.split("\n")[0] };
    });
  } else {
    // For the very last sha, check to see if the shas themselves match as a proxy for detecting any missing commit.
    const lastCommit = commits[commits.length - 1];
    const lastHistoricalCommit = shas[shas.length - 1];
    if (lastCommit.sha != lastHistoricalCommit.sha) {
      shas.push({
        sha: lastCommit.sha,
        title: lastCommit.commit.message.split("\n")[0],
      });
    }
  }

  return { title, shas };
}
