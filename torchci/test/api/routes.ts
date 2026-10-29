import { readdirSync } from "fs";
import type { RawQuery } from "lib/api/parameters";
import { join } from "path";

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

// The route files under app/api and the path each serves. A [name] folder is
// a path parameter, written {name} like OpenAPI.
export function routeFiles(
  directory = join(__dirname, "../../app/api"),
  path = "/api"
): { file: string; path: string }[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      const segment = entry.name.replace(/^\[(\w+)\]$/, "{$1}");
      return routeFiles(join(directory, entry.name), `${path}/${segment}`);
    }
    return entry.name === "route.ts"
      ? [{ file: join(directory, entry.name), path }]
      : [];
  });
}
