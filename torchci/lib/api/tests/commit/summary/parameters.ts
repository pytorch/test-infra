import {
  canonicalValues,
  parameterQueryParameters,
  parameterSchema,
  parseParameters,
  RawQuery,
} from "lib/api/parameters";
import { pathParameter } from "lib/api/schema";
import { COMMIT_PARAMETER_DEFINITIONS } from "lib/api/tests/commit/parameters";
import { CommitSummaryFieldsSchema } from "lib/api/tests/commit/summary/types";
import { z } from "zod/v4";

export type CommitSummaryField = keyof typeof CommitSummaryFieldsSchema.shape;
const COMMIT_SUMMARY_FIELDS = Object.keys(CommitSummaryFieldsSchema.shape) as [
  CommitSummaryField,
  ...CommitSummaryField[]
];

// The summary takes the commit and the fields to answer.
export const COMMIT_SUMMARY_PARAMETER_DEFINITIONS = {
  ...COMMIT_PARAMETER_DEFINITIONS,
  fields: {
    encoding: "repeat",
    schema: z
      .array(z.enum(COMMIT_SUMMARY_FIELDS))
      .min(1)
      .transform(canonicalValues)
      .optional()
      .describe(
        "Answer only these fields of the response, with hud_url and query_duration_ms; every field when omitted. Repeat this parameter to name several. The summary reads only what the named fields need: counts, first_started_at and last_ended_at read every retained run of the commit, and commit looks up its pull request and its neighbours. A commit HUD does not know is 404 whatever is named."
      ),
  },
} as const;

export const CommitSummaryParamsSchema = parameterSchema(
  COMMIT_SUMMARY_PARAMETER_DEFINITIONS
);
export type CommitSummaryQuery = z.infer<typeof CommitSummaryParamsSchema>;

export function parseCommitSummaryParams(rawQuery: RawQuery) {
  return parseParameters(
    rawQuery,
    COMMIT_SUMMARY_PARAMETER_DEFINITIONS,
    CommitSummaryParamsSchema
  );
}

export function commitSummaryParameters() {
  return [
    pathParameter("sha", CommitSummaryParamsSchema.shape.sha),
    ...parameterQueryParameters(
      CommitSummaryParamsSchema.omit({ sha: true }),
      COMMIT_SUMMARY_PARAMETER_DEFINITIONS
    ),
  ];
}
