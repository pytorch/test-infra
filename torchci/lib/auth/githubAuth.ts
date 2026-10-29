import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { getOctokitWithUserToken } from "../github";
import { hasWritePermissionsUsingOctokit } from "./githubPermissions";
// Give access to people who do not have write permissions to pytorch/pytorch
import allowList from "./allowList.json";

const REPO_OWNER = "pytorch";
const REPO_NAME = "pytorch";

export type GithubAuthResult =
  | { ok: true; login: string }
  | {
      ok: false;
      status: number;
      error: string;
      // With status 503: seconds until GitHub will answer again.
      retryAfterSeconds?: number;
    };

// What GitHub said when it refused to answer at all, as Octokit throws it.
interface GithubFailure {
  status?: unknown;
  message?: unknown;
  response?: { headers?: Record<string, unknown> };
}

// Seconds until GitHub will answer again, when the failure is GitHub's rate
// limit: a 429, or a 403 with the primary limit spent (x-ratelimit-remaining
// 0) or naming a rate limit, as the secondary limit's message does. From
// Retry-After, else the primary limit's reset time, else a minute. Null when
// the failure is something else.
function rateLimitRetryAfter(failure: GithubFailure): number | null {
  const headers = failure.response?.headers ?? {};
  const header = (name: string) => {
    const value = headers[name];
    return typeof value === "string" ? value : undefined;
  };
  const primarySpent = header("x-ratelimit-remaining") === "0";
  const named = /rate limit/i.test(String(failure.message ?? ""));
  if (
    failure.status !== 429 &&
    !(failure.status === 403 && (primarySpent || named))
  ) {
    return null;
  }
  const retryAfter = Number(header("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.ceil(retryAfter);
  }
  const reset = Number(header("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) {
    return Math.max(1, Math.ceil(reset - Date.now() / 1000));
  }
  return 60;
}

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
 * The shared HUD GitHub gate: given a GitHub token, return the login if the
 * user has write access to pytorch/pytorch (or is on the allow list),
 * otherwise a tagged failure with the HTTP status the caller should return.
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
    let hasWrite: boolean;
    try {
      hasWrite = await hasWritePermissionsUsingOctokit(
        octokit,
        login,
        REPO_OWNER,
        REPO_NAME
      );
    } catch (error) {
      // GitHub may answer the lookup with a refusal instead of a level: a
      // 404, or a 403 that is not its rate limit ("Must have push access to
      // view collaborator permission"). Either way the user has no write
      // access, and that is the verdict, not a failure of ours.
      const failure = (error ?? {}) as GithubFailure;
      if (
        failure.status === 404 ||
        (failure.status === 403 && rateLimitRetryAfter(failure) === null)
      ) {
        hasWrite = false;
      } else {
        throw error;
      }
    }
    if (!hasWrite) {
      return {
        ok: false,
        status: 403,
        error: `Write permissions to ${REPO_OWNER}/${REPO_NAME} repository required`,
      };
    }
    return { ok: true, login };
  } catch (error) {
    // GitHub refusing the token is the caller's problem. GitHub refusing to
    // answer, its rate limit for this deployment's address or for the token
    // spent, is nobody's fault here: say when to come back. Anything else is
    // ours or GitHub's.
    const failure = (error ?? {}) as GithubFailure;
    if (failure.status === 401) {
      return { ok: false, status: 401, error: "GitHub authentication failed" };
    }
    const retryAfterSeconds = rateLimitRetryAfter(failure);
    if (retryAfterSeconds !== null) {
      console.warn(
        `authorizeGithubToken: GitHub rate limit reached, retry after ${retryAfterSeconds} s`
      );
      return {
        ok: false,
        status: 503,
        error: "GitHub is rate limiting HUD; retry later",
        retryAfterSeconds,
      };
    }
    console.error("authorizeGithubToken: permission check failed", error);
    return { ok: false, status: 500, error: "Permission check failed" };
  }
}
