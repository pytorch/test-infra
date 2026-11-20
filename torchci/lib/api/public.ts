// Routes under app/api that anyone may read, without a GitHub token. Every other
// route is behind the HUD GitHub gate (lib/api/auth.ts); a public route says so by
// wrapping its handler in publicRead, and the tests that check the gate (auth.test.ts)
// and the document (openapi.test.ts) know the public prefixes by PUBLIC_API_PREFIXES.
//
// A public answer carries no caller's data, so shared caches may keep it: it is public,
// and the handler's own Cache-Control stands. A handler that sets none gets a short one.

export const PUBLIC_API_PREFIXES = ["/api/releases"];

export const DEFAULT_PUBLIC_CACHE_CONTROL =
  "public, max-age=60, s-maxage=300, stale-while-revalidate=600";

type RouteArguments = [Request, ...unknown[]];

export function isPublicApiPath(path: string): boolean {
  return PUBLIC_API_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`)
  );
}

export function publicRead<Arguments extends RouteArguments>(
  handler: (..._args: Arguments) => Promise<Response>
): (..._args: Arguments) => Promise<Response> {
  return async (...args: Arguments): Promise<Response> => {
    const response = await handler(...args);
    // An error is never worth keeping in a shared cache.
    if (!response.ok) {
      response.headers.set("Cache-Control", "no-store");
    } else if (!response.headers.has("Cache-Control")) {
      response.headers.set("Cache-Control", DEFAULT_PUBLIC_CACHE_CONTROL);
    }
    return response;
  };
}
