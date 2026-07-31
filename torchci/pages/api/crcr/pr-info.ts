import { getOctokit } from "lib/github";
import type { NextApiRequest, NextApiResponse } from "next";

const ALLOWED_UPSTREAM_REPOS = new Set(["pytorch/pytorch"]);

interface PrInfo {
  prNumber: number;
  title: string;
  author: string;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const { repo, prs } = req.query;
  if (!repo || !prs) {
    return res
      .status(400)
      .json({ error: "Missing required params: repo, prs" });
  }

  const repoStr = Array.isArray(repo) ? repo[0] : repo;

  if (!ALLOWED_UPSTREAM_REPOS.has(repoStr)) {
    return res.status(403).json({ error: "Repository not allowed" });
  }

  const prList = (Array.isArray(prs) ? prs[0] : prs)
    .split(",")
    .map(Number)
    .filter((n) => n > 0)
    .slice(0, 50);

  if (prList.length === 0) {
    return res.status(200).json([]);
  }

  const [owner, name] = repoStr.split("/");

  try {
    const octokit = await getOctokit(owner, name);

    // Single GraphQL query instead of N REST calls
    const prFragments = prList.map(
      (pr, i) => `pr${i}: pullRequest(number: ${pr}) {
        number
        title
        author { login }
      }`
    );
    const query = `query {
      repository(owner: "${owner}", name: "${name}") {
        ${prFragments.join("\n")}
      }
    }`;

    const gqlResult: any = await octokit.graphql(query);
    const repoData = gqlResult?.repository ?? {};

    const results: PrInfo[] = prList.map((prNumber, i) => {
      const pr = repoData[`pr${i}`];
      return {
        prNumber,
        title: pr?.title ?? "",
        author: pr?.author?.login ?? "",
      };
    });

    res
      .setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600")
      .status(200)
      .json(results);
  } catch (error: unknown) {
    console.error("pr-info error:", error);
    res.status(500).json({ error: "Failed to fetch PR info" });
  }
}
