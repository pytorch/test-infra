import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { authorizeGithubToken } from "./auth/githubAuth";

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
 *       has write-level access to pytorch/pytorch (see `authorizeGithubToken`).
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
  // 1. Cookie bypass logic
  const AUTH_TOKEN = process.env.GRAFANA_MCP_AUTH_TOKEN || "";
  const authCookie = req.cookies["GRAFANA_MCP_AUTH_TOKEN"];

  if (authCookie && AUTH_TOKEN && authCookie === AUTH_TOKEN) {
    console.log("Authorized: Using GRAFANA_MCP_AUTH_TOKEN cookie bypass");
    return "grafana-bypass-user";
  }

  // 2. Standard GitHub authentication flow
  // @ts-ignore – next-auth's Session type is not exported client-side
  const session = await getServerSession(req, res, authOptions);

  // @ts-ignore – next-auth's Session type is not exported client-side
  if (!session?.user || !session?.accessToken) {
    console.log("Rejected: User not authenticated");
    res.status(401).json({ error: "Authentication required" });
    return null;
  }

  // @ts-ignore – next-auth's Session type is not exported client-side
  const result = await authorizeGithubToken(session.accessToken as string);
  if (!result.ok) {
    console.log(`Rejected: ${result.error}`);
    res.status(result.status).json({ error: result.error });
    return null;
  }

  console.log(`Authorized: User ${result.login}`);
  return result.login;
}
