import { Octokit } from "octokit";
import { queryClickhouseSaved } from "./clickhouse";
import { PRData } from "./types";

async function fetchHistoricalCommits(
  owner: string,
  repo: string,
  prNumber: string
) {
  return await queryClickhouseSaved("pr_commits", {
    pr_num: prNumber,
    owner,
    repo,
  });
}

export default async function fetchPR(
  owner: string,
  repo: string,
  prNumber: string,
  octokit: Octokit
): Promise<PRData> {
  // We pull data from both our database and Github to get all commits,
  // including the ones that have been force merged out of the git history.  Our
  // database is the primary source, GitHub covers anything newer that might
  // have been missed.
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
    fetchHistoricalCommits(owner, repo, prNumber),
  ]);
  const title = pull.data.title;
  const body = pull.data.body ?? "";

  let shas = historicalCommits.map((commit) => {
    return { sha: commit.sha, title: commit.message.split("\n")[0] };
  });

  // Ideally historicalCommits will be a superset of commits, but if there's a propagation delay with
  // getting the data to our database it may be missing recent commits for a bit.
  if (shas.length == 0) {
    // If we got no data from our database, just use the commits from GitHub.
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

  return { title, body, shas };
}
