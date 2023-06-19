import type { NextApiRequest, NextApiResponse } from "next";
import { getOctokit, getOctokitWithUserToken } from "lib/github";
import { hasWritePermissionsUsingOctokit } from "lib/bot/utils";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<void>
) {
  const authorization = req.headers.authorization;
  if (authorization === undefined) {
    return res.status(403).end();
  }

  const owner = req.query["repoOwner"] as string;
  const repo = req.query["repoName"] as string;
  const workflow = req.query["workflow"] as string;
  const sha = req.query["sha"] as string;
  if (
    owner === undefined ||
    repo === undefined ||
    workflow === undefined ||
    sha === undefined
  ) {
    return res.status(400).end();
  }

  // Create an octokit instance using the provided token
  const octokit = await getOctokitWithUserToken(authorization as string);
  // Return right away if the credential is invalid
  const user = await octokit.rest.users.getAuthenticated();
  if (
    user === undefined ||
    user.data === undefined ||
    user.data.login === undefined
  ) {
    return res.status(403).end();
  }

  const username = user.data.login;
  const hasWritePermissions = await hasWritePermissionsUsingOctokit(
    octokit,
    username,
    owner,
    repo
  );
  if (!hasWritePermissions) {
    return res.status(403).end();
  }

  const tag = `ciflow/${workflow}/${sha}`;
  const matchingRefs = await octokit.rest.git.listMatchingRefs({
    owner,
    repo,
    ref: `tags/${tag}`,
  });
  if (matchingRefs !== undefined && matchingRefs.data.length > 0) {
    return res.status(200).end();
  }

  // NB: OAuth token could not be used to create a tag atm due to PyTorch org restriction. So we need to use
  // the bot token from this point onward. The good news is that it's confirmed that the user has either
  // write or admin permission when this part of the code is reached
  const botOctokit = await getOctokit(owner, repo);
  const result = await botOctokit.rest.git.createRef({
    owner,
    repo,
    ref: `refs/tags/${tag}`,
    sha: sha,
  });
  return res.status(result === undefined ? 400 : 200).end();
}
