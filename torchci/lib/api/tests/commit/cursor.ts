import {
  cursorIdentity,
  decodeCursorToken,
  encodeCursorToken,
  matchesCursorIdentity,
} from "lib/api/cursor";
import {
  CommitRunsListQuery,
  CommitRunsListQuerySchema,
} from "lib/api/tests/commit/parameters";
import {
  RunCursorPositionSchema,
  validateRunCursorPosition,
} from "lib/api/tests/test/runs/cursor";
import { runSortKeys } from "lib/api/tests/test/runs/query";
import { z } from "zod/v4";

const CommitRunsIdentitySchema = CommitRunsListQuerySchema.omit({
  limit: true,
});

export const CommitRunsCursorSchema = z
  .strictObject({
    version: z.literal(2),
    resource: z.literal("commit-runs"),
    direction: z.enum(["next", "previous"]).optional(),
    query: CommitRunsIdentitySchema,
    position: RunCursorPositionSchema,
  })
  .superRefine((cursor, context) => {
    validateRunCursorPosition(
      cursor.position,
      runSortKeys(cursor.query, true),
      context
    );
  });

export type CommitRunsCursor = z.infer<typeof CommitRunsCursorSchema>;

export function commitRunsIdentity(
  query: CommitRunsListQuery
): z.infer<typeof CommitRunsIdentitySchema> {
  return cursorIdentity(query);
}

export function encodeCommitRunsCursor(cursor: CommitRunsCursor): string {
  return encodeCursorToken(cursor);
}

export function decodeCommitRunsCursor(
  encoded: string
): CommitRunsCursor | null {
  return decodeCursorToken(CommitRunsCursorSchema, encoded);
}

export function commitRunsCursorMatchesQuery(
  cursor: CommitRunsCursor,
  query: CommitRunsListQuery
) {
  return matchesCursorIdentity(cursor, query);
}
