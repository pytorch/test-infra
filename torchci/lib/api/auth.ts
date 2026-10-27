import { createHash } from "crypto";
import { jsonError } from "lib/api/handler";
import { authorizeGithubToken } from "lib/auth/githubAuth";
import type { AuthOptions } from "next-auth";
import { getServerSession } from "next-auth";
import { authOptions } from "pages/api/auth/[...nextauth]";

// Every route under app/api except the OpenAPI document is behind the shared
// HUD GitHub gate (authorizeGithubToken): the caller's GitHub token must
// belong to a user with write access to pytorch/pytorch, or on the allow list
// in lib/auth/allowList.json. The token comes from an `Authorization: Bearer
// <token>` header, as CLI and agent callers send it, else from the HUD
// session's GitHub access token, as the browser pages have it. On a preview
// deployment the preview login's session, which has no GitHub token, passes
// instead: there the preview password is the gate. A request without a
// credential is answered 401 (unauthenticated), one whose user lacks access
// 403 (forbidden), one GitHub would not answer because it is rate limiting
// HUD 503 (unavailable, with Retry-After), and one GitHub could not be asked
// about 500 (internal_error), all in the API's error shape. Under `next dev`
// the gate stands open unless HUD_API_REQUIRE_AUTH=1.

// A route handler's parameters: the request, then whatever Next.js passes
// along, the path parameters for a route that has them.
type RouteArguments = [Request, ...unknown[]];

// What a request offers: a GitHub token, from the header or the session, or
// the preview login's session.
type Credential = { kind: "github"; token: string } | { kind: "preview" };

// A token that passed is not asked about again for this long. Asking costs
// two GitHub requests and their latency on every page of every listing, and
// access revoked in the meantime takes effect at the end of the window.
export const AUTHORIZATION_TTL_MS = 5 * 60 * 1000;
// A token GitHub refused, or whose user lacks access, gets the same answer
// without asking GitHub for this long, so a stream of bad tokens does not
// become a stream of GitHub requests from this deployment's address. Access
// granted in the meantime waits at most this long.
export const REFUSAL_TTL_MS = 60 * 1000;
// Verdicts remembered at once, per kind; past this the oldest is forgotten.
const REMEMBERED_LIMIT = 1000;

// Under `next dev` the gate stands open, so a local checkout works without a
// sign-in, for the page and for curl alike; whoever can reach the dev server
// can call its API. Set this variable to 1 to enforce the gate locally, to
// work on it: any value but an explicit no enforces it, so a misspelt yes
// fails closed. A production build, Vercel's included, always enforces it:
// `next build` compiles NODE_ENV to a constant.
export const REQUIRE_AUTH_LOCALLY = "HUD_API_REQUIRE_AUTH";
const EXPLICIT_NO = ["", "0", "false", "no", "off"];
let saidOpen = false;

function isOpenForDevelopment(): boolean {
  if (process.env.NODE_ENV !== "development") return false;
  const setting = (process.env[REQUIRE_AUTH_LOCALLY] ?? "")
    .trim()
    .toLowerCase();
  if (!EXPLICIT_NO.includes(setting)) return false;
  if (!saidOpen) {
    saidOpen = true;
    console.warn(
      `lib/api/auth: the GitHub gate stands open under next dev; set ${REQUIRE_AUTH_LOCALLY}=1 to enforce it`
    );
  }
  return true;
}

// The shared gate's refusal of a token: what to answer again.
interface Refusal {
  status: 401 | 403;
  error: string;
}

// Verdicts by the token's digest, each until a time. Keyed by the digest, so
// a token is never held in memory longer than its request.
class Remembered<Value> {
  private readonly entries = new Map<string, { until: number; value: Value }>();

  private readonly ttlMs: number;

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
  }

  get(digest: string, now: number): Value | undefined {
    const entry = this.entries.get(digest);
    if (entry === undefined) return undefined;
    if (entry.until <= now) {
      this.entries.delete(digest);
      return undefined;
    }
    return entry.value;
  }

  set(digest: string, value: Value, now: number): void {
    this.entries.delete(digest);
    this.entries.set(digest, { until: now + this.ttlMs, value });
    if (this.entries.size > REMEMBERED_LIMIT) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }
}

const admitted = new Remembered<true>(AUTHORIZATION_TTL_MS);
const refused = new Remembered<Refusal>(REFUSAL_TTL_MS);

const NO_CREDENTIAL =
  "Authentication required: send 'Authorization: Bearer <GitHub token>' or sign in to HUD.";

export function bearerTokenOf(request: Request): string | null {
  const header = request.headers.get("authorization");
  const match = header === null ? null : /^Bearer\s+(.+)$/i.exec(header);
  const token = match === null ? "" : match[1].trim();
  return token === "" ? null : token;
}

async function sessionCredential(): Promise<Credential | null> {
  const session = (await getServerSession(authOptions as AuthOptions)) as {
    accessToken?: unknown;
    previewLogin?: unknown;
  } | null;
  if (session === null) return null;
  if (session.previewLogin === true) return { kind: "preview" };
  return typeof session.accessToken === "string" && session.accessToken !== ""
    ? { kind: "github", token: session.accessToken }
    : null;
}

function isPreviewDeployment(): boolean {
  return process.env.VERCEL_ENV === "preview";
}

function digestOf(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// The shared gate's verdict on a token, remembered: an admission for
// AUTHORIZATION_TTL_MS, a refusal for REFUSAL_TTL_MS, GitHub's own trouble
// not at all. The routes under app/api and the /api/authed/ shim both answer
// from this, so a token costs GitHub requests once, whichever path it takes.
export type TokenVerdict =
  | { ok: true }
  | {
      ok: false;
      status: 401 | 403 | 500 | 503;
      error: string;
      // With 503: seconds until GitHub will answer again.
      retryAfterSeconds?: number;
    };

export async function verdictForToken(token: string): Promise<TokenVerdict> {
  const digest = digestOf(token);
  const now = Date.now();
  if (admitted.get(digest, now) === true) return { ok: true };
  const earlier = refused.get(digest, now);
  if (earlier !== undefined) return { ok: false, ...earlier };
  const verdict = await authorizeGithubToken(token);
  if (verdict.ok) {
    admitted.set(digest, true, now);
    return { ok: true };
  }
  if (verdict.status === 401 || verdict.status === 403) {
    const latest: Refusal = { status: verdict.status, error: verdict.error };
    refused.set(digest, latest, now);
    return { ok: false, ...latest };
  }
  if (verdict.status === 503) {
    return {
      ok: false,
      status: 503,
      error: verdict.error,
      retryAfterSeconds: verdict.retryAfterSeconds ?? 60,
    };
  }
  return { ok: false, status: 500, error: verdict.error };
}

// The API's stable code for each refusal.
export const CODE_BY_STATUS = {
  401: "unauthenticated",
  403: "forbidden",
  500: "internal_error",
  503: "unavailable",
} as const;

// No answer of a gated route may be stored by a shared cache and served to
// the next caller, who may be anonymous. A refusal is never stored.
const NEVER_STORED = { "Cache-Control": "no-store" };

// The headers a refusal of a token carries: never stored; the challenge that
// says the token was refused; with 503, when to come back. The shim answers
// the same.
export function refusalHeaders(
  verdict: Exclude<TokenVerdict, { ok: true }>
): Record<string, string> {
  return {
    ...NEVER_STORED,
    ...(verdict.status === 401
      ? { "WWW-Authenticate": 'Bearer error="invalid_token"' }
      : {}),
    ...(verdict.status === 503
      ? { "Retry-After": String(verdict.retryAfterSeconds ?? 60) }
      : {}),
  };
}

function unauthenticated(message: string, challenge: string): Response {
  return jsonError(401, "unauthenticated", message, undefined, {
    ...NEVER_STORED,
    "WWW-Authenticate": challenge,
  });
}

function refusal(verdict: Exclude<TokenVerdict, { ok: true }>): Response {
  return jsonError(
    verdict.status,
    CODE_BY_STATUS[verdict.status],
    verdict.error,
    undefined,
    refusalHeaders(verdict)
  );
}

// The handler's answer, marked for its caller alone: a response without a
// Cache-Control gets no-store; one that allows caching is made private, its
// `public` and `s-maxage` dropped, so a browser may keep it but no shared
// cache may. A handler that already said private or no-store is left as is.
export function forCallerOnly(response: Response): Response {
  const directives = response.headers.get("cache-control");
  if (directives === null) {
    response.headers.set("Cache-Control", "private, no-store");
  } else if (!/(^|,)\s*(private|no-store)\s*(,|$)/i.test(directives)) {
    const kept = directives
      .split(",")
      .map((directive) => directive.trim())
      .filter(
        (directive) =>
          directive !== "" && !/^(public|s-maxage\s*=.*)$/i.test(directive)
      );
    response.headers.set("Cache-Control", ["private", ...kept].join(", "));
  }
  return response;
}

// The gate's verdict on the request as the response to send, or null when
// the caller may proceed.
export async function refuseWithoutGithubWriteAccess(
  request: Request
): Promise<Response | null> {
  if (isOpenForDevelopment()) return null;
  const bearer = bearerTokenOf(request);
  const credential =
    bearer === null
      ? await sessionCredential()
      : { kind: "github" as const, token: bearer };
  if (credential === null) return unauthenticated(NO_CREDENTIAL, "Bearer");
  if (credential.kind === "preview") {
    // Only a preview deployment mints this session; anywhere else it is no
    // credential, and its made-up token is never shown to GitHub.
    return isPreviewDeployment()
      ? null
      : unauthenticated(NO_CREDENTIAL, "Bearer");
  }
  const verdict = await verdictForToken(credential.token);
  return verdict.ok ? null : refusal(verdict);
}

// The route handler behind the gate, with the handler's own signature: the
// refusal, or the handler's answer for its caller alone.
export function requireGithubWriteAccess<Arguments extends RouteArguments>(
  handler: (..._args: Arguments) => Promise<Response>
): (..._args: Arguments) => Promise<Response> {
  return async (...args) =>
    (await refuseWithoutGithubWriteAccess(args[0])) ??
    forCallerOnly(await handler(...args));
}
