import type { NextApiRequest, NextApiResponse } from "next";
import { getOctokitWithUserToken } from "lib/github";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<void>
) {
  const authorization = req.headers.authorization;
  if (authorization === undefined) {
    res.status(403).end();
  }

  const owner = req.query["repoOwner"] as string;
  const repo = req.query["repoName"] as string;
  const workflow = req.query["workflow"] as string;
  const tag_sha = req.query["sha"] as string;
  if (
    owner === undefined ||
    repo === undefined ||
    workflow === undefined ||
    tag_sha === undefined
  ) {
    res.status(400).end();
  }

  // Create an octokit instance using the provided token
  const octokit = await getOctokitWithUserToken(
    owner,
    repo,
    authorization as string
  );
  const data = await octokit.rest.git.getTag({
    owner,
    repo,
    tag_sha,
  });
  console.log(data);
  res.status(200).end();
}
