import type { RawQuery } from "lib/api/parameters";

type RouteHandler = (
  _request: Request,
  _context: { params: Promise<any> }
) => Response | Promise<Response>;

export interface RouteResponse {
  status: number;
  headers: Headers;
  body: any;
}

// Calls an app/api route handler the way Next.js does. Values for the route's
// {name} segments become its path parameters; the rest form the query string,
// one occurrence per value.
export async function callRoute(
  handler: RouteHandler,
  route: string,
  query: RawQuery = {}
): Promise<RouteResponse> {
  const params: RawQuery = {};
  const path = route.replace(/\{(\w+)\}/g, (_segment, name: string) => {
    if (query[name] !== undefined) params[name] = query[name];
    return encodeURIComponent(String(query[name] ?? ""));
  });
  const url = new URL(path, "https://hud.pytorch.org");
  for (const [name, value] of Object.entries(query)) {
    if (Object.hasOwn(params, name) || value === undefined) continue;
    for (const item of [value].flat()) url.searchParams.append(name, item);
  }
  const response = await handler(new Request(url), {
    params: Promise.resolve(params),
  });
  return {
    status: response.status,
    headers: response.headers,
    body: await response.json(),
  };
}
