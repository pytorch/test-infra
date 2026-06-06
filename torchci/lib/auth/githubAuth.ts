import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { hasWritePermissionsUsingOctokit } from "../GeneralUtils";
import { getOctokitWithUserToken } from "../github";
// Give access to people who do not have write permissions to pytorch/pytorch
import allowList from "../torchagent/allowList.json";

const REPO_OWNER = "pytorch";
const REPO_NAME = "pytorch";

export type GithubAuthResult =
  | { ok: true; login: string }
  | { ok: false; status: number; error: string };

/**
 * Resolve a GitHub token from the request: an `Authorization: Bearer <token>`
 * header takes precedence (used by CLI/curl callers), otherwise fall back to
 * the browser NextAuth session's accessToken. Returns null if neither is present.
 */
export function bearerToken(req: NextApiRequest): string | null {
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice("bearer ".length).trim() || null;
  }
  return null;
}

export async function resolveGithubToken(
  req: NextApiRequest,
  res: NextApiResponse,
  authOptions: any
): Promise<string | null> {
  const header = bearerToken(req);
  if (header) {
    return header;
  }
  const session = await getServerSession(req, res, authOptions);
  // @ts-ignore – next-auth's Session type is not exported here
  return (session?.accessToken as string) ?? null;
}

/**
 * The shared Flambeau gate: given a GitHub token, return the login if the user
 * has write access to pytorch/pytorch (or is on the allow list), otherwise a
 * tagged failure with the HTTP status the caller should return.
 */
export async function authorizeGithubToken(
  token: string
): Promise<GithubAuthResult> {
  try {
    const octokit = await getOctokitWithUserToken(token);
    const user = await octokit.rest.users.getAuthenticated();
    const login = user?.data?.login;
    if (!login) {
      return { ok: false, status: 401, error: "GitHub authentication failed" };
    }
    if (allowList.includes(login)) {
      return { ok: true, login };
    }
    const hasWrite = await hasWritePermissionsUsingOctokit(
      octokit,
      login,
      REPO_OWNER,
      REPO_NAME
    );
    if (!hasWrite) {
      return {
        ok: false,
        status: 403,
        error: `Write permissions to ${REPO_OWNER}/${REPO_NAME} repository required`,
      };
    }
    return { ok: true, login };
  } catch (error) {
    console.error("authorizeGithubToken: permission check failed", error);
    return { ok: false, status: 500, error: "Permission check failed" };
  }
}
