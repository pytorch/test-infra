import type { RawQuery } from "lib/api/parameters";
import { pathParameter } from "lib/api/schema";
import { uint64String } from "lib/api/tests/parameters";
import { z } from "zod/v4";

// The {test_id} segment of /api/tests/test/{test_id} and the paths below it.
export const TestIdSchema = uint64String.describe(
  "Stable test identity from the tests endpoints, as a UInt64 decimal string."
);

export const TestDetailParamsSchema = z.strictObject({
  test_id: TestIdSchema,
});

export function parseTestDetailParams(rawQuery: RawQuery) {
  return TestDetailParamsSchema.safeParse(rawQuery);
}

export function testDetailPathParameters() {
  return [pathParameter("test_id", TestDetailParamsSchema.shape.test_id)];
}
