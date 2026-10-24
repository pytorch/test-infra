import {
  cursorIdentity,
  decodeCursorToken,
  encodeCursorToken,
  matchesCursorIdentity,
} from "lib/api/cursor";
import {
  IDENTITY_SORT_FIELDS,
  TestListQuery,
  TestListQuerySchema,
} from "lib/api/tests/parameters";
import { sortKeys } from "lib/api/tests/query";
import { z } from "zod/v4";

export const ListIdentitySchema = TestListQuerySchema.omit({
  limit: true,
});
export type ListIdentity = z.infer<typeof ListIdentitySchema>;

export const TestListCursorSchema = z
  .strictObject({
    version: z.literal(1),
    resource: z.literal("tests"),
    query: ListIdentitySchema,
    // Kept as page metadata for existing cursors; it does not constrain paging.
    generation: z.string(),
    position: z.strictObject({
      values: z.array(z.union([z.string(), z.number().finite(), z.null()])),
    }),
  })
  .superRefine((cursor, context) => {
    const query = TestListQuerySchema.safeParse({ ...cursor.query, limit: 1 });
    if (!query.success) {
      context.addIssue({ code: "custom", message: "Invalid cursor query" });
      return;
    }
    const keys = sortKeys(query.data);
    if (keys.length !== cursor.position.values.length) {
      context.addIssue({
        code: "custom",
        message: "Cursor sort keys do not match its query",
      });
      return;
    }
    keys.forEach((key, index) => {
      const value = cursor.position.values[index];
      const isId = IDENTITY_SORT_FIELDS.some((field) => field === key.field);
      const valid =
        value === null
          ? !isId
          : key.type === "String"
          ? typeof value === "string"
          : key.type === "Float64"
          ? typeof value === "number"
          : typeof value === "string" &&
            /^(0|[1-9]\d{0,19})$/.test(value) &&
            BigInt(value) <= BigInt("18446744073709551615");
      if (!valid)
        context.addIssue({
          code: "custom",
          message: "Invalid cursor sort value",
        });
    });
  });

export type TestListCursor = z.infer<typeof TestListCursorSchema>;

// Derived from the whole normalized query, rather than a copied parameter
// list: every new filter automatically participates in cursor identity.
export function listIdentity(query: TestListQuery): ListIdentity {
  return cursorIdentity(query);
}

export function encodeCursor(cursor: TestListCursor): string {
  return encodeCursorToken(cursor);
}

export function decodeCursor(encoded: string): TestListCursor | null {
  return decodeCursorToken(TestListCursorSchema, encoded);
}

export function cursorMatchesQuery(
  cursor: TestListCursor,
  query: TestListQuery
): boolean {
  return matchesCursorIdentity(cursor, query);
}
