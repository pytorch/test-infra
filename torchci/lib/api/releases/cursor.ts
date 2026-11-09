import {
  cursorIdentity,
  decodeCursorToken,
  encodeCursorToken,
  matchesCursorIdentity,
} from "lib/api/cursor";
import type { ArtifactQuery } from "lib/api/releases/parameters";
import { ArtifactQuerySchema } from "lib/api/releases/parameters";
import { z } from "zod/v4";

// The position of a row of the artifact list: its verdict rank, then the coordinates
// the list sorts by (see ARTIFACT_SEEK_KEYS in query.ts).
const ArtifactPositionSchema = z.strictObject({
  values: z.tuple([
    z.number().int(),
    z.string(),
    z.string(),
    z.string(),
    z.string(),
    z.string(),
    z.string(),
    z.string(),
  ]),
});

export const ArtifactCursorSchema = z.strictObject({
  version: z.literal(1),
  resource: z.literal("release-artifacts"),
  direction: z.enum(["next", "previous"]).optional(),
  query: ArtifactQuerySchema.omit({ limit: true }),
  position: ArtifactPositionSchema,
});
export type ArtifactCursor = z.infer<typeof ArtifactCursorSchema>;

export function artifactIdentity(query: ArtifactQuery) {
  return cursorIdentity(query);
}

export function encodeArtifactCursor(cursor: ArtifactCursor): string {
  return encodeCursorToken(cursor);
}

export function decodeArtifactCursor(encoded: string): ArtifactCursor | null {
  return decodeCursorToken(ArtifactCursorSchema, encoded);
}

export function artifactCursorMatchesQuery(
  cursor: ArtifactCursor,
  query: ArtifactQuery
) {
  return matchesCursorIdentity(cursor, query);
}
