import { getOctokit } from "lib/github";
import type { NextApiRequest, NextApiResponse } from "next";

const ALLOWED_UPSTREAM_REPOS = new Set(["pytorch/pytorch"]);

interface CommitInfo {
  sha: string;
  title: string;
  author: string;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const { repo, shas } = req.query;
  if (!repo || !shas) {
    return res
      .status(400)
      .json({ error: "Missing required params: repo, shas" });
  }

  const repoStr = Array.isArray(repo) ? repo[0] : repo;

  if (!ALLOWED_UPSTREAM_REPOS.has(repoStr)) {
    return res.status(403).json({ error: "Repository not allowed" });
  }

  const shaList = (Array.isArray(shas) ? shas[0] : shas)
    .split(",")
    .filter(Boolean)
    .slice(0, 50);

  if (shaList.length === 0) {
    return res.status(200).json([]);
  }

  const [owner, name] = repoStr.split("/");

  try {
    const octokit = await getOctokit(owner, name);

    // Single GraphQL query instead of N REST calls
    const commitFragments = shaList.map(
      (sha, i) => `c${i}: object(oid: "${sha}") {
        ... on Commit {
          oid
          messageHeadline
          author { user { login } name }
        }
      }`
    );
    const query = `query {
      repository(owner: "${owner}", name: "${name}") {
        ${commitFragments.join("\n")}
      }
    }`;

    const gqlResult: any = await octokit.graphql(query);
    const repoData = gqlResult?.repository ?? {};

    const results: CommitInfo[] = shaList.map((sha, i) => {
      const commit = repoData[`c${i}`];
      return {
        sha,
        title: commit?.messageHeadline ?? "",
        author: commit?.author?.user?.login ?? commit?.author?.name ?? "",
      };
    });

    res
      .setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=3600")
      .status(200)
      .json(results);
  } catch (error: unknown) {
    console.error("commit-info error:", error);
    res.status(500).json({ error: "Failed to fetch commit info" });
  }
}
