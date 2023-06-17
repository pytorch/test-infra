import type { NextApiRequest, NextApiResponse } from "next";
import { getOctokit, getOctokitWithUserToken } from "lib/github";

function hasWritePermission(permission: string) {
  return permission === "admin" || permission === "write";
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<void>
) {
  const authorization = req.headers.authorization;
  if (authorization === undefined) {
    return res.status(403);
  }

  const repoOwner = req.query["repoOwner"] as string;
  const repoName = req.query["repoName"] as string;
  const workflow = req.query["workflow"] as string;
  const sha = req.query["sha"] as string;
  if (
    repoOwner === undefined ||
    repoName === undefined ||
    workflow === undefined ||
    sha === undefined
  ) {
    return res.status(400);
  }

  // Create an octokit instance using the provided token
  const octokit = await getOctokitWithUserToken(authorization as string);
  // Return right away if the credential is invalid
  const user = await octokit
    .request("GET /user")
    .catch(() => res.status(403).end());
  if (
    user === undefined ||
    user["data"] === undefined ||
    user["data"]["login"] === undefined
  ) {
    return res.status(403);
  }

  const login = user["data"]["login"];
  const permission = await octokit
    .request(
      "GET /repos/{repoOwner}/{repoName}/collaborators/{login}/permission",
      {
        repoOwner: repoOwner,
        repoName: repoName,
        login: login,
      }
    )
    .catch(() => {});
  if (
    permission === undefined ||
    permission["data"] === undefined ||
    permission["data"]["permission"] === undefined
  ) {
    return res.status(403);
  }
  if (!hasWritePermission(permission["data"]["permission"])) {
    return res.status(403);
  }

  const tag = `ciflow/${workflow}/${sha}`;
  const matchingRefs = await octokit
    .request("GET /repos/{repoOwner}/{repoName}/git/matching-refs/{ref}", {
      repoOwner: repoOwner,
      repoName: repoName,
      ref: `tags/${tag}`,
    })
    .catch(() => {});

  if (matchingRefs !== undefined && matchingRefs.data.length > 0) {
    return res.status(200);
  }

  // NB: OAuth token could not be used to create a tag atm due to PyTorch org restriction. So we need to use
  // the bot token from this point onward. The good news is that it's confirmed that the user has either
  // write or admin permission when this part of the code is reached
  const botOctokit = await getOctokit(repoOwner, repoName);
  const result = await botOctokit
    .request("POST /repos/{repoOwner}/{repoName}/git/refs", {
      repoOwner: repoOwner,
      repoName: repoName,
      ref: `refs/tags/${tag}`,
      sha: sha,
    })
    .catch((error) => console.log(error));
  return res.status(200).end();
}
