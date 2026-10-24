import { parameterError } from "lib/api/errors";
import type { RawQuery } from "lib/api/parameters";
import { ErrorResponse, errorResponse, SchemaRef } from "lib/api/schema";
import type { z } from "zod/v4";

// Request handling shared by every route under app/api: 400 naming the first
// invalid parameter, cursor checks for paginated lists, and query failures
// logged and answered without details. errorResponses() documents the same
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

export function jsonError(status: number, error: string): Response {
  const body: ErrorResponse = { error };
  return Response.json(body, { status });
}

export function rejectParameters(error: z.ZodError): Response {
  return jsonError(400, parameterError(error.issues[0]));
}

export function failQuery(
  route: string,
  message: string,
  error: unknown
): Response {
  console.error(`${route} failed:`, error);
  return jsonError(500, message);
}

// Parameters decode from each endpoint's registry; no handler lists their
// names. A cursor must decode and match the request's normalized query.
export async function handleList<
  Params extends { cursor?: string },
  Cursor,
  Page
>(
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
      "cursor must be a next_cursor returned by this endpoint"
    );
  }
  if (cursor !== null && !endpoint.cursorMatchesQuery(cursor, query)) {
    return jsonError(
      400,
      "cursor was issued for a different request; repeat the original parameters or drop the cursor"
    );
  }
  try {
    return Response.json(await endpoint.list({ query, cursor }));
  } catch (error) {
    return failQuery(endpoint.route, endpoint.failure, error);
  }
}

export function errorResponses(ref: SchemaRef, invalidRequest: string) {
  return {
    "400": errorResponse(ref, invalidRequest),
    "500": errorResponse(ref, "The query failed."),
  };
}

export function listErrorResponses(ref: SchemaRef) {
  return errorResponses(
    ref,
    "A missing or malformed parameter, an unsupported parameter, or a cursor issued for a different query or resource."
  );
}
