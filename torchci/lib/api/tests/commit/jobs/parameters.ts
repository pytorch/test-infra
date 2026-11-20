import {
  canonicalValues,
  parameterQueryParameters,
  parameterSchema,
  parseParameters,
  RawQuery,
} from "lib/api/parameters";
import { pathParameter } from "lib/api/schema";
import { CommitJobsFieldsSchema } from "lib/api/tests/commit/jobs/types";
import { COMMIT_PARAMETER_DEFINITIONS } from "lib/api/tests/commit/parameters";
import { z } from "zod/v4";

export type CommitJobsField = keyof typeof CommitJobsFieldsSchema.shape;
const COMMIT_JOBS_FIELDS = Object.keys(CommitJobsFieldsSchema.shape) as [
  CommitJobsField,
  ...CommitJobsField[]
];

// The jobs take the commit and the fields to answer.
export const COMMIT_JOBS_PARAMETER_DEFINITIONS = {
  ...COMMIT_PARAMETER_DEFINITIONS,
  fields: {
    encoding: "repeat",
    schema: z
      .array(z.enum(COMMIT_JOBS_FIELDS))
      .min(1)
      .transform(canonicalValues)
      .optional()
      .describe(
        "Answer only these fields of the response, with hud_url and query_duration_ms; both when omitted. Repeat this parameter to name both. Each field is one read, made only when the field is asked for: jobs reads the commit's jobs, and tests reads every retained run of the commit."
      ),
  },
} as const;

export const CommitJobsParamsSchema = parameterSchema(
  COMMIT_JOBS_PARAMETER_DEFINITIONS
);
export type CommitJobsQuery = z.infer<typeof CommitJobsParamsSchema>;

export function parseCommitJobsParams(rawQuery: RawQuery) {
  return parseParameters(
    rawQuery,
    COMMIT_JOBS_PARAMETER_DEFINITIONS,
    CommitJobsParamsSchema
  );
}

export function commitJobsParameters() {
  return [
    pathParameter("sha", CommitJobsParamsSchema.shape.sha),
    ...parameterQueryParameters(
      CommitJobsParamsSchema.omit({ sha: true }),
      COMMIT_JOBS_PARAMETER_DEFINITIONS
    ),
  ];
}
