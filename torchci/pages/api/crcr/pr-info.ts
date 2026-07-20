import { getOctokit } from "lib/github";
import type { NextApiRequest, NextApiResponse } from "next";

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
  const prList = (Array.isArray(prs) ? prs[0] : prs)
    .split(",")
    .map(Number)
    .filter((n) => n > 0)
    .slice(0, 50);

  if (prList.length === 0) {
    return res.status(200).json([]);
  }

  const [owner, name] = repoStr.split("/");
  if (!owner || !name) {
    return res.status(400).json({ error: "repo must be owner/name format" });
  }

  try {
    const octokit = await getOctokit(owner, name);

    const promises = prList.map(async (prNumber): Promise<PrInfo> => {
      try {
        const { data } = await octokit.rest.pulls.get({
          owner,
          repo: name,
          pull_number: prNumber,
        });
        return {
          prNumber,
          title: data.title,
          author: data.user?.login ?? "unknown",
        };
      } catch {
        return { prNumber, title: "", author: "" };
      }
    });

    const results = await Promise.all(promises);

    res
      .setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600")
      .status(200)
      .json(results);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}
