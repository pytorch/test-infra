import { getOctokit } from "lib/github";
import type { NextApiRequest, NextApiResponse } from "next";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const owner = (req.query.owner as string) || "pytorch";
  const repo = (req.query.repo as string) || "docs";

  try {
    const octokit = await getOctokit(owner, repo);
    const response = await octokit.graphql<{
      repository: { diskUsage: number };
    }>(
      `query($owner: String!, $repo: String!) {
        repository(owner: $owner, name: $repo) {
          diskUsage
        }
      }`,
      { owner, repo }
    );
    res
      .status(200)
      .json({ sizeKB: response.repository.diskUsage, owner, repo });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    res.status(500).json({ error: message });
  }
}
