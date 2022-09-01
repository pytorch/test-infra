import { getOctokit } from "./github";
import { PRData } from "./types";

export default async function fetchPR(
  owner: string,
  repo: string,
  prNumber: string
): Promise<PRData> {
  const octokit = await getOctokit(owner, repo);
  const pull_number = parseInt(prNumber);
  const [pull, commits, reviews] = await Promise.all([
    octokit.rest.pulls.get({
      owner,
      repo,
      pull_number,
    }),
    octokit.paginate(octokit.rest.pulls.listCommits, {
      owner,
      repo,
      pull_number,
      per_page: 100,
    }),
    octokit.rest.pulls.listReviews({
      owner,
      repo,
      pull_number,
    }),
  ]);
  const title = pull.data.title;
  const shas = commits.map((commit) => {
    return { sha: commit.sha, title: commit.commit.message.split("\n")[0] };
  });
  const state = pull.data.state;
  const mergeable = pull.data.mergeable ?? false;
  const reviewData = reviews.data.map((review) => {
    return {
      state: review.state,
      user: review.user?.login,
      association: review.author_association,
    };
  });
  const labels = pull.data.labels.map((label) => label.name);
  return { title, shas, state, mergeable, reviewData, labels };
}
