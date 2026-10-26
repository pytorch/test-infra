import { forwardedPath, handleList, requestQuery } from "lib/api/handler";

describe("requestQuery", () => {
  test("keeps a single value as a string and repeated values as an array, in order", async () => {
    const request = new Request(
      "https://hud.pytorch.org/api/tests?repo=pytorch%2Fpytorch&owner=b&owner=a&owner=b&search="
    );
    expect(await requestQuery(request)).toEqual({
      repo: "pytorch/pytorch",
      owner: ["b", "a", "b"],
      search: "",
    });
  });

  test("decodes the query string like a form", async () => {
    const request = new Request(
      "https://hud.pytorch.org/api/tests?search=a+b%2Bc&env_vars%5BMODE%5D=%E9%9B%AA"
    );
    expect(await requestQuery(request)).toEqual({
      search: "a b+c",
      "env_vars[MODE]": "雪",
    });
  });

  test("keeps keys named after Object.prototype members as ordinary keys", async () => {
    const request = new Request(
      "https://hud.pytorch.org/api/tests?__proto__=a&constructor=b&toString=c&toString=d"
    );
    expect(Object.entries(await requestQuery(request))).toEqual([
      ["__proto__", "a"],
      ["constructor", "b"],
      ["toString", ["c", "d"]],
    ]);
  });

  test("lets a path parameter replace a query key of the same name", async () => {
    const request = new Request(
      "https://hud.pytorch.org/api/tests/test/1/runs?test_id=2&test_id=3&limit=5"
    );
    expect(
      await requestQuery(request, Promise.resolve({ test_id: "1" }))
    ).toEqual({ test_id: "1", limit: "5" });
  });
});

describe("forwardedPath", () => {
  test.each([
    "/api/authed/tests",
    "/api/authed/tests/test/4234729730418558384/runs",
    "/api/authed/commit/0123456789abcdef0123456789abcdef01234567",
    "/a/b-c.d~e%2F",
    "/api/authed/tests/test/%E9%9B%AA",
    `/${"a".repeat(2047)}`,
  ])("accepts the plain absolute path %s", (path) => {
    const request = new Request("https://hud.pytorch.org/api/tests", {
      headers: { "x-forwarded-path": path },
    });
    expect(forwardedPath(request)).toBe(path);
  });

  test.each([
    "",
    "api/authed/tests",
    "//evil.example/api/tests",
    "https://evil.example/api/tests",
    "/api/authed/../tests",
    "/api/authed/./tests",
    "/api/authed/tests/..",
    "/api/authed/tests?x=1",
    "/api/authed/tests/",
    "/api/<script>",
    "/api/authed/tests%2",
    "/api/authed/tests%zz",
    `/${"a".repeat(2048)}`,
  ])("ignores %j", (path) => {
    const request = new Request("https://hud.pytorch.org/api/tests", {
      headers: { "x-forwarded-path": path },
    });
    expect(forwardedPath(request)).toBeNull();
  });

  test("is null without the header", () => {
    expect(
      forwardedPath(new Request("https://hud.pytorch.org/api/tests"))
    ).toBeNull();
  });
});

describe("handleList page links", () => {
  const endpoint = {
    route: "GET /api/tests",
    failure: "Failed to list tests",
    parse: (_rawQuery: unknown) => ({
      success: true as const,
      data: { repo: "pytorch/pytorch" } as { repo: string; cursor?: string },
    }),
    decodeCursor: (token: string) => ({ token }),
    cursorMatchesQuery: () => true,
    list: async () => ({
      tests: [],
      next_cursor: "next-token",
      previous_cursor: "previous-token",
    }),
  };

  test("name the request's own path", async () => {
    const request = new Request(
      "https://hud.pytorch.org/api/tests?repo=pytorch%2Fpytorch&limit=5"
    );
    const body = await (
      await handleList(request, { repo: "pytorch/pytorch" }, endpoint)
    ).json();
    expect(body.pagination).toEqual({
      next: {
        cursor: "next-token",
        url: "/api/tests?repo=pytorch%2Fpytorch&limit=5&cursor=next-token",
      },
      previous: {
        cursor: "previous-token",
        url: "/api/tests?repo=pytorch%2Fpytorch&limit=5&cursor=previous-token",
      },
    });
  });

  test("keep the caller's path when the request came through the shim", async () => {
    const request = new Request(
      "https://hud.pytorch.org/api/tests?repo=pytorch%2Fpytorch&limit=5",
      { headers: { "x-forwarded-path": "/api/authed/tests" } }
    );
    const body = await (
      await handleList(request, { repo: "pytorch/pytorch" }, endpoint)
    ).json();
    expect(body.pagination.next.url).toBe(
      "/api/authed/tests?repo=pytorch%2Fpytorch&limit=5&cursor=next-token"
    );
    expect(body.pagination.previous.url).toBe(
      "/api/authed/tests?repo=pytorch%2Fpytorch&limit=5&cursor=previous-token"
    );
  });

  test("fall back to the request's path when the forwarded one is not a plain path", async () => {
    const request = new Request(
      "https://hud.pytorch.org/api/tests?repo=pytorch%2Fpytorch",
      { headers: { "x-forwarded-path": "https://evil.example/api/tests" } }
    );
    const body = await (
      await handleList(request, { repo: "pytorch/pytorch" }, endpoint)
    ).json();
    expect(body.pagination.next.url).toBe(
      "/api/tests?repo=pytorch%2Fpytorch&cursor=next-token"
    );
  });
});
