import { getOctokit } from "./github";
import getRocksetClient from "./rockset";
import { PRData } from "./types";

export default async function fetchPR(
  owner: string,
  repo: string,
  prNumber: string
): Promise<PRData> {
  const octokit = await getOctokit(owner, repo);
  const [pull, commits] = await Promise.all([
    octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: parseInt(prNumber),
    }),
    octokit.rest.pulls.listCommits({
      owner,
      repo,
      pull_number: parseInt(prNumber),
    }),
  ]);
  const title = pull.data.title;
  const shas = commits.data.map((data) => {
    return { sha: data.sha, title: data.commit.message.split("\n")[0] };
  });

  return { title, shas };
}
