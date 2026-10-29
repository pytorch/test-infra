import {
  cursorIdentity,
  decodeCursorToken,
  encodeCursorToken,
  matchesCursorIdentity,
} from "lib/api/cursor";
import {
  RunsListQuery,
  RunsListQuerySchema,
} from "lib/api/tests/test/runs/parameters";
import { RunSortKey, runSortKeys } from "lib/api/tests/test/runs/query";
import { z } from "zod/v4";

const RunsIdentitySchema = RunsListQuerySchema.omit({ limit: true });
const UINT64_MAX = BigInt("18446744073709551615");
const INT64_MIN = BigInt("-9223372036854775808");
const INT64_MAX = BigInt("9223372036854775807");
// ClickHouse's supported DateTime64(3) range, in Unix milliseconds.
const TIMESTAMP_MIN = BigInt(Date.UTC(1900, 0, 1));
const TIMESTAMP_MAX = BigInt(Date.UTC(2300, 0, 1) - 1);

export const RunCursorPositionSchema = z.strictObject({
  values: z.array(z.string().nullable()),
});

export function validateRunCursorPosition(
  position: z.infer<typeof RunCursorPositionSchema>,
  keys: RunSortKey[],
  context: z.RefinementCtx
) {
  if (keys.length !== position.values.length) {
    context.addIssue({ code: "custom", message: "Invalid cursor key count" });
    return;
  }
  keys.forEach((key, index) => {
    const value = position.values[index];
    // Missing catalog/workflow records and unowned tests sort last. Empty
    // strings remain real values, distinct from a missing record.
    if (value === null) {
      if (!key.nullable) {
        context.addIssue({
          code: "custom",
          message: "Invalid null cursor sort value",
        });
      }
      return;
    }
    if (key.type === "String") return;
    if (!/^(0|-?[1-9]\d{0,19})$/.test(value)) {
      context.addIssue({
        code: "custom",
        message: "Invalid cursor sort value",
      });
      return;
    }
    const integer = BigInt(value);
    const [min, max] =
      key.type === "timestamp"
        ? [TIMESTAMP_MIN, TIMESTAMP_MAX]
        : key.type === "Int64"
        ? [INT64_MIN, INT64_MAX]
        : [
            BigInt(0),
            key.type === "UInt8"
              ? BigInt(255)
              : key.type === "UInt16"
              ? BigInt(65535)
              : UINT64_MAX,
          ];
    if (integer < min || integer > max) {
      context.addIssue({
        code: "custom",
        message: "Cursor value out of range",
      });
    }
  });
}

export const RunsCursorSchema = z
  .strictObject({
    version: z.literal(2),
    resource: z.literal("test-runs"),
    direction: z.enum(["next", "previous"]).optional(),
    query: RunsIdentitySchema,
    position: RunCursorPositionSchema,
  })
  .superRefine((cursor, context) => {
    validateRunCursorPosition(
      cursor.position,
      runSortKeys(cursor.query),
      context
    );
  });

export type RunsCursor = z.infer<typeof RunsCursorSchema>;

export function runsIdentity(
  query: RunsListQuery
): z.infer<typeof RunsIdentitySchema> {
  return cursorIdentity(query);
}

export function encodeRunsCursor(cursor: RunsCursor): string {
  return encodeCursorToken(cursor);
}

export function decodeRunsCursor(encoded: string): RunsCursor | null {
  return decodeCursorToken(RunsCursorSchema, encoded);
}

export function runsCursorMatchesQuery(
  cursor: RunsCursor,
  query: RunsListQuery
) {
  return matchesCursorIdentity(cursor, query);
}
