import type { RawQuery } from "lib/api/parameters";
import { pathParameter } from "lib/api/schema";
import { z } from "zod/v4";

export const RunIdSchema = z
  .string()
  .regex(
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
    "must be a UUID"
  )
  .toLowerCase()
  .describe(
    "UUID of any individual test execution, returned as attempts[].id in run records. Resolves the full bundle containing that execution. Distinct from attempts[].report.uuid and github_workflow.run_id. Uppercase hexadecimal digits are accepted and normalized to lowercase."
  );

export const RunDetailParamsSchema = z.strictObject({
  run_id: RunIdSchema,
});

export function parseRunDetailParams(rawQuery: RawQuery) {
  return RunDetailParamsSchema.safeParse(rawQuery);
}

export function runDetailPathParameters() {
  return [pathParameter("run_id", RunDetailParamsSchema.shape.run_id)];
}
