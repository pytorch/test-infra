import * as githubAuth from "lib/auth/githubAuth";
import type { NextApiRequest } from "next";
import handler from "pages/api/authed/[...path]";
import { mockRes } from "./nextApiMocks";

// The /api/authed/<path> shim: the GitHub gate, then a forward to the real
// endpoint on this deployment, token included, since the routes under app/api
// run the gate themselves.

function mockReq(headers: Record<string, string>): NextApiRequest {
  return {
    method: "GET",
    headers,
    query: { path: ["tests"], repo: "pytorch/pytorch" },
    url: "/api/authed/tests?repo=pytorch/pytorch&limit=5",
  } as unknown as NextApiRequest;
}

describe("GET /api/authed/[...path]", () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn(
      async () =>
        new Response(JSON.stringify({ tests: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test("forwards the bearer token it validated to the real endpoint", async () => {
    jest
      .spyOn(githubAuth, "authorizeGithubToken")
      .mockResolvedValue({ ok: true, login: "someone" });
    const res = mockRes();
    await handler(mockReq({ authorization: "Bearer token-admitted" }), res);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [target, init] = fetchMock.mock.calls[0];
    expect(target).toBe(
      "https://hud.pytorch.org/api/tests?repo=pytorch/pytorch&limit=5"
    );
    expect(init).toMatchObject({
      method: "GET",
      headers: {
        authorization: "Bearer token-admitted",
        "x-forwarded-path": "/api/authed/tests",
      },
    });
    expect(res._status).toBe(200);
    expect(res._headers["content-type"]).toBe("application/json");
    expect(res._json).toBe(JSON.stringify({ tests: [] }));
  });

  test("passes the upstream answer's cache, vary and retry headers back", async () => {
    jest
      .spyOn(githubAuth, "authorizeGithubToken")
      .mockResolvedValue({ ok: true, login: "someone" });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "later", code: "unavailable" }), {
        status: 503,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
          vary: "Authorization, Cookie",
          "retry-after": "42",
          "x-vercel-id": "not-copied",
        },
      })
    );
    const res = mockRes();
    await handler(mockReq({ authorization: "Bearer token-upstream-503" }), res);
    expect(res._status).toBe(503);
    expect(res._headers).toEqual({
      "content-type": "application/json",
      "cache-control": "no-store",
      vary: "Authorization, Cookie",
      "retry-after": "42",
    });
  });

  test("answers an admitted token from memory the second time", async () => {
    const authorize = jest
      .spyOn(githubAuth, "authorizeGithubToken")
      .mockResolvedValue({ ok: true, login: "someone" });
    const headers = { authorization: "Bearer token-admitted-twice" };
    await handler(mockReq(headers), mockRes());
    await handler(mockReq(headers), mockRes());
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("refuses a bad token again from memory, with the API's headers", async () => {
    const authorize = jest
      .spyOn(githubAuth, "authorizeGithubToken")
      .mockResolvedValue({
        ok: false,
        status: 401,
        error: "GitHub authentication failed",
      });
    const headers = { authorization: "Bearer token-refused-twice" };
    const first = mockRes();
    await handler(mockReq(headers), first);
    const second = mockRes();
    await handler(mockReq(headers), second);
    for (const res of [first, second]) {
      expect(res._status).toBe(401);
      expect(res._json).toEqual({
        error: "GitHub authentication failed",
        code: "unauthenticated",
      });
      expect(res._headers["Cache-Control"]).toBe("no-store");
      expect(res._headers["WWW-Authenticate"]).toBe(
        'Bearer error="invalid_token"'
      );
    }
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a GitHub rate limit is 503 with Retry-After", async () => {
    jest.spyOn(githubAuth, "authorizeGithubToken").mockResolvedValue({
      ok: false,
      status: 503,
      error: "GitHub is rate limiting HUD; retry later",
      retryAfterSeconds: 17,
    });
    const res = mockRes();
    await handler(mockReq({ authorization: "Bearer token-rate-limited" }), res);
    expect(res._status).toBe(503);
    expect(res._json).toEqual({
      error: "GitHub is rate limiting HUD; retry later",
      code: "unavailable",
    });
    expect(res._headers["Retry-After"]).toBe("17");
    expect(res._headers["Cache-Control"]).toBe("no-store");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("refuses without a bearer token before forwarding", async () => {
    const authorize = jest.spyOn(githubAuth, "authorizeGithubToken");
    const res = mockRes();
    await handler(mockReq({}), res);
    expect(res._status).toBe(401);
    expect(res._json).toMatchObject({ code: "unauthenticated" });
    expect(res._headers["Cache-Control"]).toBe("no-store");
    expect(res._headers["WWW-Authenticate"]).toBe("Bearer");
    expect(authorize).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("passes the gate's refusal through", async () => {
    jest.spyOn(githubAuth, "authorizeGithubToken").mockResolvedValue({
      ok: false,
      status: 403,
      error: "Write permissions to pytorch/pytorch repository required",
    });
    const res = mockRes();
    await handler(mockReq({ authorization: "Bearer token-read-only" }), res);
    expect(res._status).toBe(403);
    expect(res._json).toEqual({
      error: "Write permissions to pytorch/pytorch repository required",
      code: "forbidden",
    });
    expect(res._headers["Cache-Control"]).toBe("no-store");
    expect(res._headers["WWW-Authenticate"]).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
