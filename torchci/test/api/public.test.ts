import {
  DEFAULT_PUBLIC_CACHE_CONTROL,
  isPublicApiPath,
  PUBLIC_API_PREFIXES,
  publicRead,
} from "lib/api/public";

describe("isPublicApiPath", () => {
  test.each([
    ["/api/releases", true],
    ["/api/releases/2.16.0", true],
    ["/api/releases/{version}/artifacts", true],
    ["/api/releasesx", false],
    ["/api/release", false],
    ["/api/tests", false],
    ["/api/tests/releases", false],
    ["/api/openapi.json", false],
  ])("%s -> %s", (path, expected) => {
    expect(isPublicApiPath(path)).toBe(expected);
  });

  test("the public prefixes are the release portal's alone", () => {
    expect(PUBLIC_API_PREFIXES).toEqual(["/api/releases"]);
  });
});

describe("publicRead", () => {
  const request = new Request("https://hud.pytorch.org/api/releases");

  test("gives an answer without a Cache-Control the default public one", async () => {
    const response = await publicRead(async () => Response.json({ a: 1 }))(
      request
    );
    expect(response.headers.get("Cache-Control")).toBe(
      DEFAULT_PUBLIC_CACHE_CONTROL
    );
    expect(await response.json()).toEqual({ a: 1 });
  });

  test("keeps a Cache-Control the handler set", async () => {
    const response = await publicRead(async () =>
      Response.json({}, { headers: { "Cache-Control": "public, max-age=5" } })
    )(request);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=5");
  });

  test("never lets a shared cache keep an error", async () => {
    for (const status of [400, 404, 500]) {
      const response = await publicRead(async () =>
        Response.json(
          { error: "x" },
          { status, headers: { "Cache-Control": "public, max-age=60" } }
        )
      )(request);
      expect({ status, cache: response.headers.get("Cache-Control") }).toEqual({
        status,
        cache: "no-store",
      });
    }
  });

  test("passes the request and the route's context to the handler", async () => {
    const handler = jest.fn(
      async (
        _request: Request,
        _context: { params: Promise<{ version: string }> }
      ) => Response.json({})
    );
    const context = { params: Promise.resolve({ version: "2.16.0" }) };
    await publicRead(handler)(request, context);
    expect(handler).toHaveBeenCalledWith(request, context);
  });
});
