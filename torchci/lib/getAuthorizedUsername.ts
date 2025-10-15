import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { hasWritePermissionsUsingOctokit } from "./GeneralUtils";
import { getOctokitWithUserToken } from "./github";

// Users in this list do not need to have write permissions to pytorch/pytorch
// to be authorized in order to use flambeau-related features.
const FLAMBEAU_ALLOW_LIST = ["saienduri"];

/**
 * Helper that implements the common auth logic shared by the TorchAgent
 * API handlers.  It returns the GitHub username if the request is
 * authorised or sends the appropriate HTTP response and returns null when
 * unauthorised.
 *
 * The logic is:
 *   1.  If a valid `GRAFANA_MCP_AUTH_TOKEN` cookie is present, allow the
 *       request immediately and return the special placeholder user
 *       "grafana-bypass-user".
 *   2.  Otherwise ensure that the caller is authenticated with GitHub and
 *       has write-level access to pytorch/pytorch.
 *
 * Each API route should call this function early.  If the function returns
 * `null` the route must `return` immediately because the HTTP response has
 * already been written.
 */
export async function getAuthorizedUsername(
  req: NextApiRequest,
  res: NextApiResponse,
  authOptions: any
): Promise<string | null> {
  // 1. Cookie bypass logic -------------------------------------------------
  const AUTH_TOKEN = process.env.GRAFANA_MCP_AUTH_TOKEN || "";
  const authCookie = req.cookies["GRAFANA_MCP_AUTH_TOKEN"];

  if (authCookie && AUTH_TOKEN && authCookie === AUTH_TOKEN) {
    console.log("Authorized: Using GRAFANA_MCP_AUTH_TOKEN cookie bypass");
    return "grafana-bypass-user";
  }

  // 2. Standard GitHub authentication flow --------------------------------
  // @ts-ignore – next-auth's Session type is not exported client-side
  const session = await getServerSession(req, res, authOptions);

  // @ts-ignore – next-auth's Session type is not exported client-side
  if (!session?.user || !session?.accessToken) {
    console.log("Rejected: User not authenticated");
    res.status(401).json({ error: "Authentication required" });
    return null;
  }

  const repoOwner = "pytorch";
  const repoName = "pytorch";

  try {
    const octokit = await getOctokitWithUserToken(
      // @ts-ignore – next-auth's Session type is not exported client-side
      session.accessToken as string
    );
    const user = await octokit.rest.users.getAuthenticated();

    if (!user?.data?.login) {
      console.log("Rejected: Could not authenticate user with GitHub");
      res.status(401).json({ error: "GitHub authentication failed" });
      return null;
    }

    if (FLAMBEAU_ALLOW_LIST.includes(user.data.login)) {
      console.log(
        `Authorized: User ${user.data.login} is in the flambeau allow list`
      );
      return user.data.login;
    }

    const hasWritePermissions = await hasWritePermissionsUsingOctokit(
      octokit,
      user.data.login,
      repoOwner,
      repoName
    );

    if (!hasWritePermissions) {
      console.log(
        `Rejected: User ${user.data.login} does not have write permissions to ${repoOwner}/${repoName}`
      );
      res.status(403).json({
        error: "Write permissions to pytorch/pytorch repository required",
      });
      return null;
    }

    console.log(`Authorized: User ${user.data.login} has write permissions`);
    return user.data.login;
  } catch (error) {
    console.error("Error checking permissions:", error);
    res.status(500).json({ error: "Permission check failed" });
    return null;
  }
}
