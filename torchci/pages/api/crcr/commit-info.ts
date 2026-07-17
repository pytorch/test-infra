import { getOctokit } from "lib/github";
import type { NextApiRequest, NextApiResponse } from "next";

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
  const shaList = (Array.isArray(shas) ? shas[0] : shas)
    .split(",")
    .filter(Boolean)
    .slice(0, 50);

  if (shaList.length === 0) {
    return res.status(200).json([]);
  }

  const [owner, name] = repoStr.split("/");
  if (!owner || !name) {
    return res.status(400).json({ error: "repo must be owner/name format" });
  }

  try {
    const octokit = await getOctokit(owner, name);
    const results: CommitInfo[] = [];

    // Fetch commits in parallel (bounded to 50 max)
    const promises = shaList.map(async (sha) => {
      try {
        const { data } = await octokit.rest.repos.getCommit({
          owner,
          repo: name,
          ref: sha,
        });
        const message = data.commit.message.split("\n")[0];
        return {
          sha,
          title: message,
          author: data.author?.login ?? data.commit.author?.name ?? "unknown",
        };
      } catch {
        return { sha, title: "", author: "" };
      }
    });

    const settled = await Promise.all(promises);
    results.push(...settled);

    // Commits are immutable — cache aggressively
    res
      .setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=3600")
      .status(200)
      .json(results);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}
