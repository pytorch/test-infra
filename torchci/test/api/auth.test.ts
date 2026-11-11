import {
  AUTHORIZATION_TTL_MS,
  bearerTokenOf,
  forCallerOnly,
  REFUSAL_TTL_MS,
  requireGithubWriteAccess,
} from "lib/api/auth";
import { isPublicApiPath } from "lib/api/public";
import { ErrorResponseSchema } from "lib/api/schema";
import * as githubAuth from "lib/auth/githubAuth";
import * as clickhouse from "lib/clickhouse";
import { getServerSession } from "next-auth";
import { routeFiles } from "./routes";

// The GitHub gate in front of every route under app/api: where the token
// comes from, what each verdict of the shared gate becomes, how long a
// token that passed is remembered, and which routes let HUD's public pages
// through. GitHub itself is the mocked shared gate; the HUD session is the
// mocked next-auth reader.

jest.mock("next-auth", () => ({ getServerSession: jest.fn() }));

const ORIGIN = "https://hud.pytorch.org";
const sessionReader = getServerSession as jest.Mock;

function request(path: string, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}${path}`, { headers });
}

// What a browser adds to a request that one of HUD's pages makes.
const FROM_A_HUD_PAGE = { "sec-fetch-site": "same-origin" };

// The routes HUD's public pages under pages/tests/[organization] read. They
// admit the pages' requests; every other route asks every caller for a
// credential.
const PAGE_ROUTES = [
  "/api/tests",
  "/api/tests/commit/{sha}",
  "/api/tests/commit/{sha}/greenlight",
  "/api/tests/commit/{sha}/summary",
  "/api/tests/cost",
  "/api/tests/cost/changes",
  "/api/tests/cost/trend",
  "/api/tests/options",
  "/api/tests/pull/{number}",
  "/api/tests/test/{test_id}",
  "/api/tests/test/{test_id}/runs",
];

// The gated routes: every route under app/api but the document's own and the
// public ones (lib/api/public.ts).
function gatedRoutes(): { file: string; path: string }[] {
  return routeFiles().filter(
    ({ path }) => path !== "/api/openapi.json" && !isPublicApiPath(path)
  );
}

// The route file's GET, called as Next.js calls it, with 1 for every path
// parameter.
async function callGet(
  file: string,
  path: string,
  headers: Record<string, string> = {}
): Promise<Response> {
  const route = await import(file);
  const params: Record<string, string> = {};
  const concrete = path.replace(/\{(\w+)\}/g, (_segment, name: string) => {
    params[name] = "1";
    return "1";
  });
  return route.GET(request(concrete, headers), {
    params: Promise.resolve(params),
  });
}

type Context = { params: Promise<Record<string, string>> };

describe("the GitHub gate on app/api routes", () => {
  let authorize: jest.SpyInstance;
  let handler: jest.Mock<Promise<Response>, [Request, Context]>;
  let gated: (_request: Request, _context: Context) => Promise<Response>;
  const context: Context = { params: Promise.resolve({}) };

  beforeEach(() => {
    sessionReader.mockReset();
    sessionReader.mockResolvedValue(null);
    authorize = jest.spyOn(githubAuth, "authorizeGithubToken");
    handler = jest.fn(async (_request: Request, _context: Context) =>
      Response.json({ answered: true })
    );
    gated = requireGithubWriteAccess(handler);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("every route under app/api except the document refuses an anonymous request", async () => {
    const routes = gatedRoutes();
    expect(routes.length).toBeGreaterThanOrEqual(6);
    for (const { file, path } of routes) {
      const response = await callGet(file, path);
      expect({ path, status: response.status }).toEqual({ path, status: 401 });
      expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
      const body = await response.json();
      expect(ErrorResponseSchema.parse(body)).toEqual(body);
      expect(body).toEqual({
        error: expect.stringMatching(/Authorization: Bearer/),
        code: "unauthenticated",
      });
    }
    expect(authorize).not.toHaveBeenCalled();
  });

  test("the routes HUD's pages read admit a page's request, and no other route does", async () => {
    // Past the gate, a handler answers as it would from an empty database.
    jest.spyOn(clickhouse, "queryClickhouse").mockResolvedValue([]);
    jest.spyOn(console, "error").mockImplementation(() => {});
    const admitted: string[] = [];
    for (const { file, path } of gatedRoutes()) {
      const response = await callGet(file, path, FROM_A_HUD_PAGE);
      if (response.status !== 401) admitted.push(path);
    }
    expect(admitted.sort()).toEqual(PAGE_ROUTES);
    expect(authorize).not.toHaveBeenCalled();
  });

  describe("a request one of HUD's pages made", () => {
    let forPages: typeof gated;

    beforeEach(() => {
      forPages = requireGithubWriteAccess(handler, { admitHudPages: true });
    });

    test("passes a route that admits the pages, with no session or GitHub asked", async () => {
      const response = await forPages(
        request("/api/tests", FROM_A_HUD_PAGE),
        context
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ answered: true });
      // Still for its caller alone: no shared cache keeps it.
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(sessionReader).not.toHaveBeenCalled();
      expect(authorize).not.toHaveBeenCalled();
    });

    test("is anonymous on a route that does not admit the pages", async () => {
      const response = await gated(
        request("/api/tests", FROM_A_HUD_PAGE),
        context
      );
      expect(response.status).toBe(401);
      expect((await response.json()).code).toBe("unauthenticated");
      expect(handler).not.toHaveBeenCalled();
    });

    test.each(["same-site", "cross-site", "none", ""])(
      "is not what a request with Sec-Fetch-Site %j is",
      async (site) => {
        const response = await forPages(
          request("/api/tests", { "sec-fetch-site": site }),
          context
        );
        expect(response.status).toBe(401);
        expect(handler).not.toHaveBeenCalled();
      }
    );

    test("still has a bearer token it sends checked", async () => {
      authorize.mockResolvedValue({
        ok: false,
        status: 401,
        error: "GitHub authentication failed",
      });
      const response = await forPages(
        request("/api/tests", {
          ...FROM_A_HUD_PAGE,
          authorization: "Bearer token-sent-by-a-page",
        }),
        context
      );
      expect(response.status).toBe(401);
      expect(response.headers.get("WWW-Authenticate")).toBe(
        'Bearer error="invalid_token"'
      );
      expect(authorize).toHaveBeenCalledWith("token-sent-by-a-page");
      expect(handler).not.toHaveBeenCalled();
    });
  });

  test("only the release portal's routes are exempt from the gate", () => {
    expect(
      routeFiles()
        .filter(({ path }) => isPublicApiPath(path))
        .map(({ path }) => path)
        .sort()
    ).toEqual([
      "/api/releases",
      "/api/releases/{version}",
      "/api/releases/{version}/artifacts",
      "/api/releases/{version}/config",
    ]);
  });

  test("a bearer token is checked by the shared gate and admitted", async () => {
    authorize.mockResolvedValue({ ok: true, login: "someone" });
    const admitted = request("/api/tests", {
      authorization: "Bearer token-admitted",
    });
    const response = await gated(admitted, context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ answered: true });
    expect(authorize).toHaveBeenCalledWith("token-admitted");
    expect(handler).toHaveBeenCalledWith(admitted, context);
    expect(sessionReader).not.toHaveBeenCalled();
  });

  test("without a header, the HUD session's GitHub token is checked", async () => {
    sessionReader.mockResolvedValue({
      user: { name: "someone" },
      accessToken: "session-token-admitted",
    });
    authorize.mockResolvedValue({ ok: true, login: "someone" });
    const response = await gated(request("/api/tests"), context);
    expect(response.status).toBe(200);
    expect(authorize).toHaveBeenCalledWith("session-token-admitted");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("a header outranks the session", async () => {
    sessionReader.mockResolvedValue({ accessToken: "session-token-ignored" });
    authorize.mockResolvedValue({ ok: true, login: "someone" });
    await gated(
      request("/api/tests", { authorization: "bearer token-over-session" }),
      context
    );
    expect(authorize).toHaveBeenCalledWith("token-over-session");
    expect(sessionReader).not.toHaveBeenCalled();
  });

  test("a session without a GitHub token is anonymous", async () => {
    sessionReader.mockResolvedValue({ user: { name: "someone" } });
    const response = await gated(request("/api/tests"), context);
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe("unauthenticated");
    expect(authorize).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  test("a token GitHub refuses is 401 with an invalid_token challenge", async () => {
    authorize.mockResolvedValue({
      ok: false,
      status: 401,
      error: "GitHub authentication failed",
    });
    const response = await gated(
      request("/api/tests", { authorization: "Bearer token-refused" }),
      context
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe(
      'Bearer error="invalid_token"'
    );
    expect(await response.json()).toEqual({
      error: "GitHub authentication failed",
      code: "unauthenticated",
    });
    expect(handler).not.toHaveBeenCalled();
  });

  test("a user without write access is 403 forbidden", async () => {
    authorize.mockResolvedValue({
      ok: false,
      status: 403,
      error: "Write permissions to pytorch/pytorch repository required",
    });
    const response = await gated(
      request("/api/tests", { authorization: "Bearer token-read-only" }),
      context
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("WWW-Authenticate")).toBeNull();
    const body = await response.json();
    expect(ErrorResponseSchema.parse(body)).toEqual(body);
    expect(body).toEqual({
      error: "Write permissions to pytorch/pytorch repository required",
      code: "forbidden",
    });
    expect(handler).not.toHaveBeenCalled();
  });

  test("GitHub being unreachable is 500 internal_error", async () => {
    authorize.mockResolvedValue({
      ok: false,
      status: 500,
      error: "Permission check failed",
    });
    const response = await gated(
      request("/api/tests", { authorization: "Bearer token-unlucky" }),
      context
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Permission check failed",
      code: "internal_error",
    });
    expect(handler).not.toHaveBeenCalled();
  });

  test("a token that passed is remembered until the TTL runs out", async () => {
    const now = jest.spyOn(Date, "now");
    now.mockReturnValue(1_000_000);
    authorize.mockResolvedValue({ ok: true, login: "someone" });
    const headers = { authorization: "Bearer token-remembered" };
    await gated(request("/api/tests", headers), context);
    await gated(request("/api/tests/options", headers), context);
    now.mockReturnValue(1_000_000 + AUTHORIZATION_TTL_MS - 1);
    await gated(request("/api/tests", headers), context);
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(3);
    now.mockReturnValue(1_000_000 + AUTHORIZATION_TTL_MS);
    await gated(request("/api/tests", headers), context);
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledTimes(4);
  });

  test("a refusal is answered again for a minute without asking GitHub", async () => {
    const now = jest.spyOn(Date, "now");
    now.mockReturnValue(2_000_000);
    authorize.mockResolvedValueOnce({
      ok: false,
      status: 403,
      error: "Write permissions to pytorch/pytorch repository required",
    });
    authorize.mockResolvedValueOnce({ ok: true, login: "someone" });
    const headers = { authorization: "Bearer token-granted-later" };
    const first = await gated(request("/api/tests", headers), context);
    expect(first.status).toBe(403);
    now.mockReturnValue(2_000_000 + REFUSAL_TTL_MS - 1);
    const again = await gated(request("/api/tests/options", headers), context);
    expect(again.status).toBe(403);
    expect(await again.json()).toEqual(await first.json());
    expect(again.headers.get("Cache-Control")).toBe("no-store");
    expect(authorize).toHaveBeenCalledTimes(1);
    now.mockReturnValue(2_000_000 + REFUSAL_TTL_MS);
    expect((await gated(request("/api/tests", headers), context)).status).toBe(
      200
    );
    expect(authorize).toHaveBeenCalledTimes(2);
  });

  test("a token GitHub refused is refused again from memory, with its challenge", async () => {
    authorize.mockResolvedValue({
      ok: false,
      status: 401,
      error: "GitHub authentication failed",
    });
    const headers = { authorization: "Bearer token-refused-twice" };
    await gated(request("/api/tests", headers), context);
    const again = await gated(request("/api/tests", headers), context);
    expect(again.status).toBe(401);
    expect(again.headers.get("WWW-Authenticate")).toBe(
      'Bearer error="invalid_token"'
    );
    expect(authorize).toHaveBeenCalledTimes(1);
  });

  test("GitHub rate limiting HUD is 503 unavailable with Retry-After, not remembered", async () => {
    authorize.mockResolvedValue({
      ok: false,
      status: 503,
      error: "GitHub is rate limiting HUD; retry later",
      retryAfterSeconds: 37,
    });
    const headers = { authorization: "Bearer token-rate-limited" };
    const response = await gated(request("/api/tests", headers), context);
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("37");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json();
    expect(ErrorResponseSchema.parse(body)).toEqual(body);
    expect(body).toEqual({
      error: "GitHub is rate limiting HUD; retry later",
      code: "unavailable",
    });
    await gated(request("/api/tests", headers), context);
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(handler).not.toHaveBeenCalled();
  });

  describe("under next dev", () => {
    const env = process.env as Record<string, string | undefined>;
    const nodeEnv = env.NODE_ENV;
    const requireAuth = env.HUD_API_REQUIRE_AUTH;

    beforeEach(() => {
      env.NODE_ENV = "development";
      delete env.HUD_API_REQUIRE_AUTH;
      jest.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      env.NODE_ENV = nodeEnv;
      if (requireAuth === undefined) delete env.HUD_API_REQUIRE_AUTH;
      else env.HUD_API_REQUIRE_AUTH = requireAuth;
    });

    test("the gate stands open: an anonymous request is answered", async () => {
      const response = await gated(request("/api/tests"), context);
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(sessionReader).not.toHaveBeenCalled();
      expect(authorize).not.toHaveBeenCalled();
      expect(handler).toHaveBeenCalledTimes(1);
    });

    test.each(["1", "true", "yes", "enforce", " 1 "])(
      "HUD_API_REQUIRE_AUTH=%j enforces it",
      async (value) => {
        env.HUD_API_REQUIRE_AUTH = value;
        const response = await gated(request("/api/tests"), context);
        expect(response.status).toBe(401);
        expect(handler).not.toHaveBeenCalled();
      }
    );

    test.each(["0", "false", "no", "off", ""])(
      "HUD_API_REQUIRE_AUTH=%j leaves it open",
      async (value) => {
        env.HUD_API_REQUIRE_AUTH = value;
        const response = await gated(request("/api/tests"), context);
        expect(response.status).toBe(200);
      }
    );
  });

  describe("the preview login", () => {
    const deployment = process.env.VERCEL_ENV;
    const previewSession = {
      user: { name: "Preview User" },
      accessToken: "made-up-preview-token",
      previewLogin: true,
    };

    afterEach(() => {
      if (deployment === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = deployment;
    });

    test("passes on a preview deployment without asking GitHub", async () => {
      process.env.VERCEL_ENV = "preview";
      sessionReader.mockResolvedValue(previewSession);
      const response = await gated(request("/api/tests"), context);
      expect(response.status).toBe(200);
      expect(authorize).not.toHaveBeenCalled();
      expect(handler).toHaveBeenCalledTimes(1);
    });

    test("is no credential anywhere else, and its token never reaches GitHub", async () => {
      process.env.VERCEL_ENV = "production";
      sessionReader.mockResolvedValue(previewSession);
      const response = await gated(request("/api/tests"), context);
      expect(response.status).toBe(401);
      expect((await response.json()).code).toBe("unauthenticated");
      expect(authorize).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    });

    test("does not outrank a bearer header on a preview deployment", async () => {
      process.env.VERCEL_ENV = "preview";
      sessionReader.mockResolvedValue(previewSession);
      authorize.mockResolvedValue({
        ok: false,
        status: 403,
        error: "Write permissions to pytorch/pytorch repository required",
      });
      const response = await gated(
        request("/api/tests", { authorization: "Bearer token-on-preview" }),
        context
      );
      expect(response.status).toBe(403);
      expect(sessionReader).not.toHaveBeenCalled();
    });
  });

  test.each([
    ["Bearer abc", "abc"],
    ["bearer abc", "abc"],
    ["BEARER   abc  ", "abc"],
    ["Bearer", null],
    ["Bearer   ", null],
    ["Basic abc", null],
    ["abc", null],
  ])("reads the bearer token of %j as %j", (header, token) => {
    expect(
      bearerTokenOf(request("/api/tests", { authorization: header }))
    ).toBe(token);
  });

  test("no Authorization header is no bearer token", () => {
    expect(bearerTokenOf(request("/api/tests"))).toBeNull();
  });

  test.each([
    ["no token", {}, { ok: true, login: "someone" }],
    [
      "a refused token",
      { authorization: "Bearer token-refused-not-stored" },
      { ok: false, status: 401, error: "GitHub authentication failed" },
    ],
    [
      "a user without write access",
      { authorization: "Bearer token-read-only-not-stored" },
      { ok: false, status: 403, error: "Write permissions required" },
    ],
    [
      "GitHub being unreachable",
      { authorization: "Bearer token-unlucky-not-stored" },
      { ok: false, status: 500, error: "Permission check failed" },
    ],
  ])(
    "a refusal for %s is never stored by a cache",
    async (_name, headers, verdict) => {
      authorize.mockResolvedValue(verdict);
      const response = await gated(request("/api/tests", headers), context);
      expect(response.status).toBeGreaterThanOrEqual(401);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
  );

  test("a handler's answer without Cache-Control is for its caller alone", async () => {
    authorize.mockResolvedValue({ ok: true, login: "someone" });
    const response = await gated(
      request("/api/tests", { authorization: "Bearer token-answer-private" }),
      context
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  test.each([
    [
      "public, max-age=300, stale-while-revalidate=3600",
      "private, max-age=300, stale-while-revalidate=3600",
    ],
    ["max-age=60", "private, max-age=60"],
    ["public, s-maxage=600, max-age=0", "private, max-age=0"],
    ["Public, S-MaxAge = 10", "private"],
    ["private, max-age=300", "private, max-age=300"],
    ["no-store", "no-store"],
    ["max-age=0, no-store", "max-age=0, no-store"],
  ])(
    "a handler's Cache-Control %j becomes %j, so no shared cache keeps the answer",
    (given, expected) => {
      const response = Response.json(
        { answered: true },
        { headers: { "Cache-Control": given } }
      );
      expect(forCallerOnly(response).headers.get("Cache-Control")).toBe(
        expected
      );
    }
  );
});
