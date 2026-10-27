import type { RawQuery } from "lib/api/parameters";
import { queryParameters } from "lib/api/schema";
import { z } from "zod/v4";

// The endpoint takes no parameters. The strict empty schema still rejects any
// query parameter as unknown, as every endpoint does, and documents none.
export const TestOptionsParamsSchema = z.strictObject({});

export function parseTestOptionsParams(rawQuery: RawQuery) {
  return TestOptionsParamsSchema.safeParse(rawQuery);
}

export function testOptionsQueryParameters() {
  return queryParameters(TestOptionsParamsSchema);
}
