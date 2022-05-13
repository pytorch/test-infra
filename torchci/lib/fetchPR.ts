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
        octokit.paginate(octokit.rest.pulls.listCommits, {
            owner,
            repo,
            pull_number: parseInt(prNumber),
            per_page: 100,
            endpoint: {
                url: "/repos/{owner}/{repo}/commits",
            },
        }),
    ]);
    const title = pull.data.title;
    const shas = commits.map((commit) => {
        return { sha: commit.sha, title: commit.commit.message.split("\n")[0] };
    });

    return { title, shas };
}
