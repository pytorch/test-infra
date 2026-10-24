import { parameterError, parameterIssues } from "lib/api/errors";
import type { RawQuery } from "lib/api/parameters";
import { ErrorResponse, errorResponse, SchemaRef } from "lib/api/schema";
import type { z } from "zod/v4";

// Request handling shared by every route under app/api: validation issues and
// stable error codes, the paginated list flow with its cursor checks, the
// detail flow with its 404, and query failures logged and answered without
// details. errorResponses() documents the same
// statuses in /api/openapi.json. Route files export only GET; Next.js answers
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

export function jsonError(
  status: number,
  code: ErrorResponse["code"],
  error: string,
  issues?: ErrorResponse["issues"]
): Response {
  const body: ErrorResponse = {
    error,
    code,
    ...(issues === undefined ? {} : { issues }),
  };
  return Response.json(body, { status });
}

export function rejectParameters(error: z.ZodError): Response {
  return jsonError(
    400,
    "invalid_parameters",
    parameterError(error.issues[0]),
    parameterIssues(error)
  );
}

export function failQuery(
  route: string,
  message: string,
  error: unknown
): Response {
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
    const link = (token: string | null) => {
      if (token === null) return null;
      const url = new URL(request.url);
      url.searchParams.set("cursor", token);
      return { cursor: token, url: `${url.pathname}${url.search}` };
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
    "500": errorResponse(ref, "The query failed (internal_error)."),
  };
}

export function listErrorResponses(ref: SchemaRef) {
  return errorResponses(
    ref,
    "A missing, malformed or unsupported parameter (invalid_parameters); a malformed or unsupported cursor, including one for a different resource (invalid_cursor); or a cursor issued for a different query (cursor_query_mismatch)."
  );
}
