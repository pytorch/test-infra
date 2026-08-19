import { Octokit } from "octokit";
import { queryClickhouse, queryClickhouseSaved } from "./clickhouse";
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

interface PRTitleBody {
  title: string;
  body: string;
  headSha: string;
}

async function fetchPRTitleBody(
  owner: string,
  repo: string,
  prNumber: string
): Promise<PRTitleBody | undefined> {
  // Read the PR's title/body/head sha from the default.pull_request mirror
  // instead of the GitHub API. Filter on `number` (the table's sorting key) for
  // an indexed lookup; html_url pins the repo since PR numbers are not unique
  // across repos. FINAL collapses the ReplacingMergeTree to the latest row.
  const query = `
SELECT
    title,
    body,
    head.'sha' AS head_sha
FROM default.pull_request FINAL
WHERE
    number = {prNumber: Int64}
    AND html_url = {htmlUrl: String}
  `;
  const rows = await queryClickhouse(query, {
    prNumber,
    htmlUrl: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
  });
  if (rows.length !== 1) {
    return undefined;
  }
  return {
    title: rows[0].title,
    body: rows[0].body ?? "",
    headSha: rows[0].head_sha,
  };
}

export default async function fetchPR(
  owner: string,
  repo: string,
  prNumber: string,
  octokit: Octokit,
  knownHeadSha?: string
): Promise<PRData> {
  // We pull data from both our database and Github to get all commits,
  // including the ones that have been force merged out of the git history.  Our
  // database is the primary source, GitHub covers anything newer that might
  // have been missed.
  //
  // Both ClickHouse reads run in parallel so a covered PR resolves in a single
  // round trip and never touches the GitHub REST API. Each read independently
  // falls back to GitHub on an empty result OR on error, so a ClickHouse outage
  // degrades to GitHub-only behaviour instead of failing the refresh.
  const [titleBodySettled, historicalCommitsSettled] = await Promise.allSettled(
    [
      fetchPRTitleBody(owner, repo, prNumber),
      fetchHistoricalCommits(owner, repo, prNumber),
    ]
  );

  let titleBody: PRTitleBody | undefined;
  if (titleBodySettled.status === "fulfilled") {
    titleBody = titleBodySettled.value;
  } else {
    console.warn(
      `fetchPR: ClickHouse title/body query failed for ${owner}/${repo}#${prNumber}, falling back to GitHub`,
      titleBodySettled.reason
    );
  }

  let title: string;
  let body: string;
  if (titleBody !== undefined) {
    title = titleBody.title;
    body = titleBody.body;
  } else {
    // No ClickHouse row (or the query errored): fall back to the GitHub API.
    const pull = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: parseInt(prNumber),
    });
    title = pull.data.title;
    body = pull.data.body ?? "";
  }

  let historicalCommits: any[] = [];
  if (historicalCommitsSettled.status === "fulfilled") {
    historicalCommits = historicalCommitsSettled.value;
  } else {
    console.warn(
      `fetchPR: ClickHouse pr_commits query failed for ${owner}/${repo}#${prNumber}, falling back to GitHub`,
      historicalCommitsSettled.reason
    );
  }

  let shas = historicalCommits.map((commit) => {
    return { sha: commit.sha, title: commit.message.split("\n")[0] };
  });

  // The reference head sha is the caller-supplied head (Dr. CI already knows it)
  // or, failing that, the head sha from the ClickHouse pull_request row. When it
  // is undefined (e.g. the /pull page with a ClickHouse miss) we can't prove our
  // commit list is current, so we fall through to GitHub exactly like before.
  const referenceHeadSha = knownHeadSha ?? titleBody?.headSha;
  const newestHistoricalSha =
    shas.length > 0 ? shas[shas.length - 1].sha : undefined;

  // Skip the GitHub listCommits call when our database already has the tip:
  // there are commits AND the newest one matches the known PR head. Otherwise
  // (empty list, or newest sha differs) hit GitHub and reconcile below. Fork PRs
  // return empty from pr_commits, so they naturally fall back.
  if (shas.length !== 0 && newestHistoricalSha === referenceHeadSha) {
    return { title, body, shas };
  }

  const commits = await octokit.paginate(octokit.rest.pulls.listCommits, {
    owner,
    repo,
    pull_number: parseInt(prNumber),
    per_page: 100,
  });

  // Ideally historicalCommits will be a superset of commits, but if there's a propagation delay with
  // getting the data to our database it may be missing recent commits for a bit.
  if (shas.length === 0) {
    // If we got no data from our database, just use the commits from GitHub.
    shas = commits.map((commit) => {
      return { sha: commit.sha, title: commit.commit.message.split("\n")[0] };
    });
  } else if (commits.length === 0) {
    return { title, body, shas };
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
