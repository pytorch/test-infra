import { ClickHouseError } from "@clickhouse/client";
import { parameterError, parameterIssues } from "lib/api/errors";
import type { RawQuery } from "lib/api/parameters";
import { ErrorResponse, errorResponse, SchemaRef } from "lib/api/schema";
import type { z } from "zod/v4";

// Request handling shared by every route under app/api: validation issues and
// stable error codes, the paginated list flow with its cursor checks, the
// detail flow with its 404, and query failures logged and answered without
// details, except a heavy query the database's queue refuses, which is a 429
// with Retry-After. errorResponses() documents the same statuses in /api/openapi.json,
// with the 401 and 403 of the GitHub gate in lib/api/auth.ts. Route files export only GET; Next.js answers
// HEAD by running it and dropping the body, OPTIONS with 204, and the other
// standard methods with an empty 405.

type ParseResult<Params> =
  | { success: true; data: Params }
  | { success: false; error: z.ZodError };

// The request's parameters as one raw query for the parameter registries: a
// repeated query key becomes an array, and a path parameter replaces a query
// key of the same name. Without a prototype, keys such as __proto__ stay
// ordinary keys, so the strict schemas reject them like any unknown parameter.
export async function requestQuery(
  request: Request,
  params?: Promise<Record<string, string>>
): Promise<RawQuery> {
  const query: Record<string, string | string[]> = Object.create(null);
  for (const [key, value] of new URL(request.url).searchParams) {
    const existing = query[key];
    if (existing === undefined) query[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else query[key] = [existing, value];
  }
  return { ...query, ...(await params) };
}

// The path the caller asked, when the request came through the /api/authed/
// shim, which names it in x-forwarded-path: page links keep that path, so
// they work for the caller that follows them. Anything but a plain absolute
// path of ordinary segments (no `.` or `..`, only complete percent-escapes,
// no query, no scheme or host, no more than a URL's worth) is ignored, and
// the request's own path stands.
const PLAIN_PATH = /^(\/(?!\.\.?(\/|$))(?:[A-Za-z0-9_.~-]|%[0-9A-Fa-f]{2})+)+$/;
const PLAIN_PATH_LIMIT = 2048;

export function forwardedPath(request: Request): string | null {
  const path = request.headers.get("x-forwarded-path");
  return path !== null &&
    path.length <= PLAIN_PATH_LIMIT &&
    PLAIN_PATH.test(path)
    ? path
    : null;
}

export function jsonError(
  status: number,
  code: ErrorResponse["code"],
  error: string,
  issues?: ErrorResponse["issues"],
  headers?: HeadersInit
): Response {
  const body: ErrorResponse = {
    error,
    code,
    ...(issues === undefined ? {} : { issues }),
  };
  return Response.json(body, { status, headers });
}

export function rejectParameters(error: z.ZodError): Response {
  return jsonError(
    400,
    "invalid_parameters",
    parameterError(error.issues[0]),
    parameterIssues(error)
  );
}

// How long the caller of a refused heavy query should wait before asking
// again. The workload runs two heavy queries per replica at about eight
// seconds each, so a full queue of 16 frees a place every few seconds, and
// half a minute leaves room for the retry.
export const OVERLOADED_RETRY_AFTER_SECONDS = 30;

// Whether the database refused the query because the heavy-query workload's
// queue was full (app/api/README.md, Heavy queries). The Node client parses
// the error name out of the server's message.
export function isOverloaded(error: unknown): boolean {
  return error instanceof ClickHouseError && error.type === "SERVER_OVERLOADED";
}

export function failQuery(
  route: string,
  message: string,
  error: unknown
): Response {
  if (isOverloaded(error)) {
    // Expected under load, not a defect: a warning, no stack.
    console.warn(`${route} refused: the heavy-query queue is full`);
    return jsonError(
      429,
      "overloaded",
      "The database is busy with other heavy queries; try again in a moment",
      undefined,
      { "Retry-After": String(OVERLOADED_RETRY_AFTER_SECONDS) }
    );
  }
  console.error(`${route} failed:`, error);
  return jsonError(500, "internal_error", message);
}

// Parameters decode from each endpoint's registry; no handler lists their
// names. A cursor must decode and match the request's normalized query.
export async function handleList<
  Params extends { cursor?: string },
  Cursor,
  Page extends { next_cursor: string | null; previous_cursor: string | null }
>(
  request: Request,
  rawQuery: RawQuery,
  endpoint: {
    route: string;
    failure: string;
    parse: (_rawQuery: RawQuery) => ParseResult<Params>;
    decodeCursor: (_token: string) => Cursor | null;
    cursorMatchesQuery: (
      _cursor: Cursor,
      _query: Omit<Params, "cursor">
    ) => boolean;
    list: (_request: {
      query: Omit<Params, "cursor">;
      cursor: Cursor | null;
    }) => Promise<Page>;
  }
): Promise<Response> {
  const parsed = endpoint.parse(rawQuery);
  if (!parsed.success) return rejectParameters(parsed.error);
  const { cursor: rawCursor, ...query } = parsed.data;
  const cursor =
    rawCursor === undefined ? null : endpoint.decodeCursor(rawCursor);
  if (rawCursor !== undefined && cursor === null) {
    return jsonError(
      400,
      "invalid_cursor",
      "cursor must be a pagination.next.cursor or pagination.previous.cursor returned by this endpoint"
    );
  }
  if (cursor !== null && !endpoint.cursorMatchesQuery(cursor, query)) {
    return jsonError(
      400,
      "cursor_query_mismatch",
      "cursor was issued for a different request; repeat the original parameters or drop the cursor"
    );
  }
  try {
    const { next_cursor, previous_cursor, ...page } = await endpoint.list({
      query,
      cursor,
    });
    const path = forwardedPath(request);
    const link = (token: string | null) => {
      if (token === null) return null;
      const url = new URL(request.url);
      url.searchParams.set("cursor", token);
      return { cursor: token, url: `${path ?? url.pathname}${url.search}` };
    };
    return Response.json({
      ...page,
      pagination: { next: link(next_cursor), previous: link(previous_cursor) },
    });
  } catch (error) {
    return failQuery(endpoint.route, endpoint.failure, error);
  }
}

// A detail endpoint resolves its path parameter to one object: 400 for an
// invalid request, 404 when nothing has that identity, 500 for a query failure.
export async function handleDetail<Params, Detail extends object>(
  rawQuery: RawQuery,
  endpoint: {
    route: string;
    failure: string;
    notFound: string;
    parse: (_rawQuery: RawQuery) => ParseResult<Params>;
    get: (_params: Params) => Promise<Detail | null>;
  }
): Promise<Response> {
  const parsed = endpoint.parse(rawQuery);
  if (!parsed.success) return rejectParameters(parsed.error);
  try {
    const detail = await endpoint.get(parsed.data);
    if (detail === null) return jsonError(404, "not_found", endpoint.notFound);
    return Response.json(detail);
  } catch (error) {
    return failQuery(endpoint.route, endpoint.failure, error);
  }
}

export function errorResponses(ref: SchemaRef, invalidRequest: string) {
  return {
    "400": errorResponse(ref, invalidRequest),
    "401": errorResponse(
      ref,
      "No GitHub token: send an Authorization: Bearer header or sign in to HUD (unauthenticated)."
    ),
    "403": errorResponse(
      ref,
      "The GitHub user has no write access to pytorch/pytorch and is not on the allow list (forbidden)."
    ),
    "500": errorResponse(
      ref,
      "The query failed, or GitHub could not be asked about the token (internal_error)."
    ),
    "503": errorResponse(
      ref,
      "GitHub is rate limiting HUD, so the token could not be checked; retry after the Retry-After seconds (unavailable)."
    ),
  };
}

// Every list runs a heavy query (app/api/README.md, Heavy queries), so a list
// can also be refused.
export function listErrorResponses(ref: SchemaRef) {
  return {
    ...errorResponses(
      ref,
      "A missing, malformed or unsupported parameter (invalid_parameters); a malformed or unsupported cursor, including one for a different resource (invalid_cursor); or a cursor issued for a different query (cursor_query_mismatch)."
    ),
    "429": errorResponse(
      ref,
      "The database's queue for heavy queries is full; retry after the Retry-After seconds (overloaded)."
    ),
  };
}
