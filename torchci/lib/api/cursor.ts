import { isDeepStrictEqual } from "node:util";
import type { z } from "zod/v4";

// Cursor rules shared by every paginated endpoint. A cursor token is base64url
// JSON checked against the endpoint's cursor schema; a token that does not
// decode and validate yields null, which the handler rejects with 400 rather
// than misreading. A cursor binds the normalized query except page size, and
// absent optional parameters stay absent, so adding one keeps cursors valid.

export function encodeCursorToken(cursor: object): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCursorToken<Cursor>(
  schema: z.ZodType<Cursor>,
  token: string
): Cursor | null {
  try {
    const result = schema.safeParse(
      JSON.parse(Buffer.from(token, "base64url").toString("utf8"))
    );
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function cursorIdentity<Query extends { limit: number }>(
  query: Query
): Omit<Query, "limit"> {
  const { limit: _pageSize, ...identity } = query;
  return Object.fromEntries(
    Object.entries(identity).filter(([, value]) => value !== undefined)
  ) as Omit<Query, "limit">;
}

export function matchesCursorIdentity(
  cursor: { query: unknown },
  query: { limit: number }
): boolean {
  return isDeepStrictEqual(cursor.query, cursorIdentity(query));
}
