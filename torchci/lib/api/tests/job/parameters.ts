import type { RawQuery } from "lib/api/parameters";
import { pathParameter } from "lib/api/schema";
import { z } from "zod/v4";

// A GitHub job as the job endpoint, the commit runs' job_id filter and the
// commit page address it. Zod only, so the pages can import it. Up to 18
// digits: the queries bind it as an Int64, which holds any of those.
export const JobIdSchema = z
  .string()
  .regex(/^[1-9]\d{0,17}$/, "must be a GitHub job ID")
  .describe(
    "GitHub Actions job ID, github_workflow.job_id in run records, as a decimal string."
  );

export const JobDetailParamsSchema = z.strictObject({
  job_id: JobIdSchema,
});
export type JobDetailQuery = z.infer<typeof JobDetailParamsSchema>;

export function parseJobDetailParams(rawQuery: RawQuery) {
  return JobDetailParamsSchema.safeParse(rawQuery);
}

export function jobDetailPathParameters() {
  return [pathParameter("job_id", JobDetailParamsSchema.shape.job_id)];
}
